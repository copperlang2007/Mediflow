-- Day-5 native e-signature (Beta) — replaces the third-party Dropbox Sign /
-- DocuSign integration originally planned for this slot. See
-- artifacts/api-server/src/lib/esign/mediflowProvider.ts for the runtime
-- contract.
--
-- Two new tables, both org-scoped:
--
--   esign_envelopes        — the durable record of a signing flow. One row
--                            per carrier_contracting_request. Holds the
--                            unsigned + signed document references, the
--                            signer list, integrity hash + consent record.
--
--   esign_signing_events   — the granular audit trail. Every interaction
--                            with an envelope (created / viewed / consent
--                            accepted / signature captured / completed /
--                            voided) writes a row. This is the evidence
--                            that justifies the electronic signature; the
--                            envelope table without these events would be
--                            unauditable.
--
-- Beta scope: PKI signing of the final PDF, KBA, voice/SMS verification,
-- and long-term-validation timestamps land in Phase 3. The
-- `integrity_sha256` column + the audit trail of events are the v1 tamper
-- evidence story.
--
-- Idempotent: every CREATE uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "esign_envelopes" (
  "id"                              text PRIMARY KEY,
  "org_id"                          text NOT NULL REFERENCES "organizations"("id"),
  "carrier_contracting_request_id"  text NOT NULL REFERENCES "carrier_contracting_requests"("id") ON DELETE CASCADE,
  "unsigned_pdf_document_id"        text NOT NULL REFERENCES "documents"("id"),
  "signed_pdf_document_id"          text REFERENCES "documents"("id"),
  "signers"                         jsonb NOT NULL,
  "status"                          text NOT NULL DEFAULT 'pending',
  "integrity_sha256"                text,
  "consent_record"                  jsonb,
  "signed_at"                       timestamptz,
  "voided_at"                       timestamptz,
  "created_at"                      timestamptz NOT NULL DEFAULT now(),
  "updated_at"                      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One active envelope per carrier_contracting_request. A voided envelope
-- frees the slot so an admin can retry — same partial-unique idiom as
-- `agent_onboarding_runs_active_per_agent_unique`.
CREATE UNIQUE INDEX IF NOT EXISTS "esign_envelopes_active_per_request_unique"
  ON "esign_envelopes" ("org_id", "carrier_contracting_request_id")
  WHERE status != 'voided';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "esign_envelopes_org_status_idx"
  ON "esign_envelopes" ("org_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "esign_signing_events" (
  "id"             text PRIMARY KEY,
  "org_id"         text NOT NULL REFERENCES "organizations"("id"),
  "envelope_id"    text NOT NULL REFERENCES "esign_envelopes"("id") ON DELETE CASCADE,
  "event_type"     text NOT NULL,
  "actor_user_id"  text,
  "ip_address"     text,
  "user_agent"     text,
  "event_data"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "esign_signing_events_envelope_time_idx"
  ON "esign_signing_events" ("envelope_id", "occurred_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "esign_signing_events_org_idx"
  ON "esign_signing_events" ("org_id");
