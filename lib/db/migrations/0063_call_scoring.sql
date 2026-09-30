-- Native call scoring (phase 2a: text transcripts only; no speech-to-text).
--
--   call_transcripts       one row per transcript. The text lives ONLY as
--                          AES-256-GCM ciphertext (PHI field encryption), plus
--                          a keyed digest (HMAC) of the original canonical speech for
--                          duplicate detection (unique per org). No plaintext phone column.
--   call_scores            one immutable automatic result per scoring run. A
--                          rescore inserts a new row; nothing ever edits one.
--   call_score_findings    one row per criterion result / piece of evidence,
--                          plus one row per possible do-not-contact request.
--                          Quotes are encrypted.
--   call_score_reviews     append-only human decisions layered on top of the
--                          immutable result (criterion overrides and
--                          do-not-contact resolutions).
--
-- Retention: retain_until is never sooner than the CMS 10-year floor. Nothing
-- in this migration deletes anything; purged_at exists for a future,
-- explicitly approved purge job.

-- Email opt-outs need a uniqueness guarantee of their own: the (org, phone,
-- channel) index ignores them because phone is NULL. Two concurrent email
-- opt-outs for one address could each insert a row.
--
-- Existing duplicates (same org and address ignoring case) may differ in source
-- and opted_out_at, which is compliance provenance, so nothing is discarded:
-- every duplicate is first COPIED, in full, into opt_outs_dedup_archive (with
-- the id of the row that was kept and when it was archived), and only then
-- removed from opt_outs. The EARLIEST row of each address stays in opt_outs.
-- The count is reported with a NOTICE. The archive table is an audit copy and is
-- not read by the application.
CREATE TABLE IF NOT EXISTS "opt_outs_dedup_archive" (
	LIKE "opt_outs" INCLUDING DEFAULTS,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kept_id" text NOT NULL
);--> statement-breakpoint
INSERT INTO "opt_outs_dedup_archive"
SELECT a.*, now(), k."id"
FROM "opt_outs" a
JOIN LATERAL (
  SELECT b."id" FROM "opt_outs" b
  WHERE b."channel" = 'email' AND b."email" IS NOT NULL
    AND b."org_id" = a."org_id" AND lower(b."email") = lower(a."email")
  ORDER BY b."opted_out_at", b."id"
  LIMIT 1
) k ON k."id" <> a."id"
WHERE a."channel" = 'email' AND a."email" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "opt_outs_dedup_archive" x WHERE x."id" = a."id");--> statement-breakpoint
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM "opt_outs" WHERE "id" IN (SELECT "id" FROM "opt_outs_dedup_archive");
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'opt_outs: % duplicate email opt-out row(s) moved to opt_outs_dedup_archive (earliest row of each address kept)', removed;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opt_outs_org_email_channel_unique" ON "opt_outs" ("org_id", lower("email"), "channel") WHERE "channel" = 'email' AND "email" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"contact_id" text REFERENCES "contacts"("id") ON DELETE set null,
	"call_session_id" text REFERENCES "call_sessions"("id") ON DELETE set null,
	"agent_id" text REFERENCES "agents"("id") ON DELETE set null,
	"source" text DEFAULT 'upload' NOT NULL,
	"format" text NOT NULL,
	"external_ref" text,
	"call_date" timestamp with time zone,
	"contact_match" text DEFAULT 'none' NOT NULL,
	"transcript_encrypted" bytea,
	"content_digest" bytea NOT NULL,
	"speaker_mode" text NOT NULL,
	"timing" text NOT NULL,
	"utterance_count" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer,
	"created_by" text REFERENCES "users"("id") ON DELETE set null,
	"retain_until" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_transcripts_source_check" CHECK ("source" IN ('upload','import','enrollhere_download','dialer','other')),
	CONSTRAINT "call_transcripts_format_check" CHECK ("format" IN ('paste','txt','vtt','srt','json')),
	CONSTRAINT "call_transcripts_contact_match_check" CHECK ("contact_match" IN ('none','explicit','phone_unique','phone_ambiguous')),
	CONSTRAINT "call_transcripts_speaker_mode_check" CHECK ("speaker_mode" IN ('labelled','partial','unlabelled')),
	CONSTRAINT "call_transcripts_timing_check" CHECK ("timing" IN ('recorded','estimated'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcripts_org_id_created_at_idx" ON "call_transcripts" ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_transcripts_org_digest_uidx" ON "call_transcripts" ("org_id","content_digest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcripts_contact_id_idx" ON "call_transcripts" ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcripts_call_session_id_idx" ON "call_transcripts" ("call_session_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"transcript_id" text NOT NULL REFERENCES "call_transcripts"("id") ON DELETE cascade,
	"rubric_id" text NOT NULL,
	"rubric_version" text NOT NULL,
	"score" integer NOT NULL,
	"compliance_status" text NOT NULL,
	"critical_failure_count" integer DEFAULT 0 NOT NULL,
	"needs_review_count" integer DEFAULT 0 NOT NULL,
	"dnc_flag_count" integer DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'rules' NOT NULL,
	"ai_status" text DEFAULT 'skipped' NOT NULL,
	"ai_model" text,
	"ai_error" text,
	"speaker_mode" text NOT NULL,
	"scored_by" text REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_scores_compliance_check" CHECK ("compliance_status" IN ('pass','fail','review')),
	CONSTRAINT "call_scores_method_check" CHECK ("method" IN ('rules','rules+ai')),
	CONSTRAINT "call_scores_ai_status_check" CHECK ("ai_status" IN ('used','needs_setup','failed','skipped')),
	CONSTRAINT "call_scores_score_range_check" CHECK ("score" >= 0 AND "score" <= 100)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_scores_org_id_created_at_idx" ON "call_scores" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_scores_transcript_id_created_at_idx" ON "call_scores" ("transcript_id","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_score_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"score_id" text NOT NULL REFERENCES "call_scores"("id") ON DELETE cascade,
	"transcript_id" text NOT NULL REFERENCES "call_transcripts"("id") ON DELETE cascade,
	"criterion_id" text NOT NULL,
	"criterion_name" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"verdict" text NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"speaker" text,
	"utterance_index" integer,
	"end_utterance_index" integer,
	"start_offset" integer,
	"end_offset" integer,
	"start_seconds" real,
	"fraction" real DEFAULT 0 NOT NULL,
	"max_points" real DEFAULT 0 NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence_encrypted" bytea,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_score_findings_kind_check" CHECK ("kind" IN ('required','prohibited','judgment','dnc')),
	CONSTRAINT "call_score_findings_severity_check" CHECK ("severity" IN ('critical','major','minor')),
	CONSTRAINT "call_score_findings_verdict_check" CHECK ("verdict" IN ('pass','partial','fail','na','needs_review','flag')),
	CONSTRAINT "call_score_findings_source_check" CHECK ("source" IN ('rules','llm','rules+llm')),
	CONSTRAINT "call_score_findings_speaker_check" CHECK ("speaker" IS NULL OR "speaker" IN ('agent','client','unknown'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_score_findings_score_id_idx" ON "call_score_findings" ("score_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_score_findings_org_kind_idx" ON "call_score_findings" ("org_id","kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_score_findings_transcript_id_idx" ON "call_score_findings" ("transcript_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_score_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"transcript_id" text NOT NULL REFERENCES "call_transcripts"("id") ON DELETE cascade,
	"score_id" text NOT NULL REFERENCES "call_scores"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"criterion_id" text,
	"fingerprint" text,
	"verdict" text NOT NULL,
	"fraction" real,
	"note_encrypted" bytea,
	"contact_id" text REFERENCES "contacts"("id") ON DELETE set null,
	"opt_out_recorded" boolean DEFAULT false NOT NULL,
	"reviewer_user_id" text REFERENCES "users"("id") ON DELETE set null,
	"reviewer_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_score_reviews_kind_check" CHECK ("kind" IN ('override','dnc_resolution')),
	CONSTRAINT "call_score_reviews_verdict_check" CHECK ("verdict" IN ('pass','partial','fail','na','revert','opt_out_added','dismissed')),
	CONSTRAINT "call_score_reviews_shape_check" CHECK (
		("kind" = 'override' AND "criterion_id" IS NOT NULL AND "verdict" IN ('pass','partial','fail','na','revert'))
		OR ("kind" = 'dnc_resolution' AND "fingerprint" IS NOT NULL AND "verdict" IN ('opt_out_added','dismissed'))
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_score_reviews_score_id_idx" ON "call_score_reviews" ("score_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_score_reviews_org_transcript_idx" ON "call_score_reviews" ("org_id","transcript_id");--> statement-breakpoint
-- One resolution per possible do-not-contact request (per transcript + position),
-- so two reviewers clicking at once cannot both act, and a rescore cannot re-open it.
CREATE UNIQUE INDEX IF NOT EXISTS "call_score_reviews_dnc_once_key" ON "call_score_reviews" ("org_id","transcript_id","fingerprint") WHERE "kind" = 'dnc_resolution';--> statement-breakpoint

-- The automatic result is immutable. Scores never change after insert; a
-- finding may only have its encrypted evidence cleared (a future approved
-- purge). Reviews are append-only. The ONLY other update allowed is the one
-- PostgreSQL itself runs for `ON DELETE SET NULL` foreign keys (a contact or a
-- user being hard-deleted): contact_id / reviewer_user_id / scored_by may go
-- from a value to NULL and nothing else may change, so an approved contact
-- delete is not blocked by the history that referenced it. Deletes stay
-- possible so an approved purge of a transcript can cascade.
CREATE OR REPLACE FUNCTION call_scoring_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'call_score_findings' THEN
    IF NEW.evidence_encrypted IS NULL
       AND (to_jsonb(NEW) - 'evidence_encrypted') = (to_jsonb(OLD) - 'evidence_encrypted') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'call_score_reviews' THEN
    IF (to_jsonb(NEW) - 'contact_id' - 'reviewer_user_id') = (to_jsonb(OLD) - 'contact_id' - 'reviewer_user_id')
       AND (NEW.contact_id IS NULL OR NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id)
       AND (NEW.reviewer_user_id IS NULL OR NEW.reviewer_user_id IS NOT DISTINCT FROM OLD.reviewer_user_id) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'call_scores' THEN
    IF (to_jsonb(NEW) - 'scored_by') = (to_jsonb(OLD) - 'scored_by')
       AND (NEW.scored_by IS NULL OR NEW.scored_by IS NOT DISTINCT FROM OLD.scored_by) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% rows are immutable: the automatic result and review history cannot be edited', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS call_scores_no_update ON call_scores;--> statement-breakpoint
CREATE TRIGGER call_scores_no_update BEFORE UPDATE ON call_scores FOR EACH ROW EXECUTE FUNCTION call_scoring_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS call_score_findings_no_update ON call_score_findings;--> statement-breakpoint
CREATE TRIGGER call_score_findings_no_update BEFORE UPDATE ON call_score_findings FOR EACH ROW EXECUTE FUNCTION call_scoring_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS call_score_reviews_no_update ON call_score_reviews;--> statement-breakpoint
CREATE TRIGGER call_score_reviews_no_update BEFORE UPDATE ON call_score_reviews FOR EACH ROW EXECUTE FUNCTION call_scoring_immutable();
