-- Call recordings, post-merge review fixes:
--  * committed_at: when transcription was committed (confirm). The daily cap
--    counts committed recordings from this moment, not from link creation.
--  * purge_after: durable "delete this audio" work for refused, oversized and
--    abandoned uploads. The sweep deletes the object once the signed upload
--    link has expired (so it cannot be re-uploaded afterwards) and clears this
--    only when the delete succeeded, so a failed delete is retried with
--    backoff (purge_attempts).
--  * call_score_claims: one recording at a time may add a score to a given
--    call, so two duplicate uploads cannot both score (and pay for) it.
ALTER TABLE "call_recordings" ADD COLUMN IF NOT EXISTS "committed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "call_recordings" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "call_recordings" ADD COLUMN IF NOT EXISTS "purge_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- call_recordings is new (migration 0064, October 2026), so this touches at most a few
-- days of rows; one statement is fine.
UPDATE "call_recordings" SET "committed_at" = "created_at"
WHERE "committed_at" IS NULL AND ("status" IN ('queued','transcribing','scored') OR ("status" = 'failed' AND "attempts" > 0));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_recordings_purge_after_idx" ON "call_recordings" ("purge_after") WHERE "purge_after" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_score_claims" (
	"transcript_id" text PRIMARY KEY NOT NULL REFERENCES "call_transcripts"("id") ON DELETE CASCADE,
	"claimed_at" timestamp with time zone NOT NULL
);
