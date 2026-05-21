-- Agent onboarding + carrier-contracting tables for the INSUREitALL design
-- partner v1. See lib/db/src/schema/onboarding.ts for the drizzle-side
-- definitions + column-by-column rationale.
--
-- Three tables, all org-scoped:
--   - agent_onboarding_runs        (one in-flight onboarding per agent)
--   - agent_contracting_profiles   (encrypted PII vault for paperwork data)
--   - carrier_contracting_requests (one per onboarding × carrier)
--
-- Defense-in-depth:
--   - All SSN / EIN storage is AES-256-GCM ciphertext + HMAC-SHA256 blind
--     index, reusing the PHI_ENCRYPTION_KEY / PHI_HMAC_KEY pair from
--     the medicare_id implementation. Keys live in app env, NOT in the DB.
--   - Partial-unique indexes enforce "one active row" semantics so cancelled
--     records do not block fresh attempts.
--
-- Idempotent: every CREATE uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "agent_onboarding_runs" (
  "id"               text PRIMARY KEY,
  "org_id"           text NOT NULL REFERENCES "organizations"("id"),
  "agent_id"         text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "status"           text NOT NULL DEFAULT 'draft',
  "started_at"       timestamptz NOT NULL DEFAULT now(),
  "completed_at"     timestamptz,
  "completed_steps"  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "agent_onboarding_runs_active_per_agent_unique"
  ON "agent_onboarding_runs" ("org_id", "agent_id")
  WHERE status != 'cancelled';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_onboarding_runs_org_status_idx"
  ON "agent_onboarding_runs" ("org_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_contracting_profiles" (
  "agent_id"                         text PRIMARY KEY REFERENCES "agents"("id") ON DELETE CASCADE,
  "org_id"                           text NOT NULL REFERENCES "organizations"("id"),
  "ssn_encrypted"                    bytea,
  "ssn_hash"                         bytea,
  "dob"                              date,
  "home_address_line1"               text,
  "home_address_line2"               text,
  "home_city"                        text,
  "home_state"                       text,
  "home_zip"                         text,
  "mailing_same_as_home"             boolean NOT NULL DEFAULT true,
  "mailing_address_line1"            text,
  "mailing_address_line2"            text,
  "mailing_city"                     text,
  "mailing_state"                    text,
  "mailing_zip"                      text,
  "phone"                            text,
  "email"                            text,
  "entity_type"                      text,
  "business_name"                    text,
  "business_ein_encrypted"           bytea,
  "e_and_o_carrier"                  text,
  "e_and_o_policy_number"            text,
  "e_and_o_expires_on"               date,
  "background_check_status"          text NOT NULL DEFAULT 'not_started',
  "background_check_authorized_at"   timestamptz,
  "background_check_cleared_at"      timestamptz,
  "created_at"                       timestamptz NOT NULL DEFAULT now(),
  "updated_at"                       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_contracting_profiles_org_idx"
  ON "agent_contracting_profiles" ("org_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_contracting_profiles_ssn_hash_idx"
  ON "agent_contracting_profiles" ("ssn_hash")
  WHERE "ssn_hash" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "carrier_contracting_requests" (
  "id"                       text PRIMARY KEY,
  "org_id"                   text NOT NULL REFERENCES "organizations"("id"),
  "onboarding_run_id"        text NOT NULL REFERENCES "agent_onboarding_runs"("id") ON DELETE CASCADE,
  "agent_id"                 text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "carrier_id"               text NOT NULL REFERENCES "carriers"("id"),
  "states"                   text[] NOT NULL,
  "status"                   text NOT NULL DEFAULT 'draft',
  "paperwork_document_id"    text REFERENCES "documents"("id") ON DELETE SET NULL,
  "signature_envelope_id"    text,
  "signature_completed_at"   timestamptz,
  "submitted_at"             timestamptz,
  "appointed_at"             timestamptz,
  "writing_number"           text,
  "carrier_response_data"    jsonb NOT NULL DEFAULT '{}'::jsonb,
  "notes"                    text NOT NULL DEFAULT '',
  "last_status_change_at"    timestamptz NOT NULL DEFAULT now(),
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "carrier_contracting_requests_active_per_carrier_unique"
  ON "carrier_contracting_requests" ("org_id", "agent_id", "carrier_id")
  WHERE status != 'cancelled';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "carrier_contracting_requests_run_idx"
  ON "carrier_contracting_requests" ("onboarding_run_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "carrier_contracting_requests_org_status_idx"
  ON "carrier_contracting_requests" ("org_id", "status");
