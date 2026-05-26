-- Phase 1.5 pivot — Power-of-Attorney signing replaces per-carrier signing.
--
-- The new architecture: agents sign ONE POA per onboarding run that authorizes
-- INSUREitALL to submit carrier contracts on their behalf. Per-carrier signing
-- envelopes are retired; the per-carrier `carrier_contracting_requests` now go
-- straight from `draft` to either `awaiting_admin_submission` (POA-authorized,
-- admin handles the off-system submissions) or `invite_requested` (agent
-- opted out — each carrier emails the agent a self-service invite).
--
-- This migration is purely additive against existing rows:
--   - new columns are nullable / defaulted so legacy runs continue to read.
--   - the existing per-carrier flow still works for any in-flight runs (the
--     state machine retains the old transitions).
--
-- Three changes:
--
--   1. `agent_onboarding_runs` — POA bookkeeping columns.
--
--   2. `esign_envelopes` — make `carrier_contracting_request_id` nullable and
--      add `onboarding_run_id` so a single envelope can be linked to either
--      a per-carrier request (legacy) OR an onboarding run (POA path). A
--      check constraint ensures exactly one of the two is populated.
--
--   3. New `carrier_contracting_requests.status` values are text-enum (no
--      DB-level enum to alter); the state machine module is the source of
--      truth. No schema change here — included as a marker comment so the
--      migration log captures the pivot.

ALTER TABLE "agent_onboarding_runs"
  ADD COLUMN IF NOT EXISTS "poa_status" text NOT NULL DEFAULT 'not_applicable';
--> statement-breakpoint

ALTER TABLE "agent_onboarding_runs"
  ADD COLUMN IF NOT EXISTS "poa_envelope_id" text;
--> statement-breakpoint

ALTER TABLE "agent_onboarding_runs"
  ADD COLUMN IF NOT EXISTS "poa_expires_at" timestamp with time zone;
--> statement-breakpoint

-- esign_envelopes: allow POA envelopes (no carrier_contracting_request) and
-- attach a nullable onboarding_run_id for the POA path.

ALTER TABLE "esign_envelopes"
  ALTER COLUMN "carrier_contracting_request_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "esign_envelopes"
  ADD COLUMN IF NOT EXISTS "onboarding_run_id" text
    REFERENCES "agent_onboarding_runs"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Exactly one of the two parent FKs must be populated. A POA envelope sets
-- onboarding_run_id; a legacy per-carrier envelope sets
-- carrier_contracting_request_id. Older rows are migrated to satisfy the
-- constraint by virtue of having carrier_contracting_request_id set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'esign_envelopes_parent_check'
  ) THEN
    ALTER TABLE "esign_envelopes"
      ADD CONSTRAINT "esign_envelopes_parent_check"
      CHECK (
        ("carrier_contracting_request_id" IS NOT NULL AND "onboarding_run_id" IS NULL)
        OR
        ("carrier_contracting_request_id" IS NULL AND "onboarding_run_id" IS NOT NULL)
      );
  END IF;
END $$;
--> statement-breakpoint

-- Unique index on (org, onboarding_run_id) for POA envelopes so idempotent
-- re-create returns the same envelope. Mirrors the existing
-- esign_envelopes_active_per_request_unique index for the per-carrier flow.
CREATE UNIQUE INDEX IF NOT EXISTS "esign_envelopes_active_per_run_unique"
  ON "esign_envelopes" ("org_id", "onboarding_run_id")
  WHERE "onboarding_run_id" IS NOT NULL AND "status" != 'voided';
--> statement-breakpoint

-- Marker: carrier_contracting_requests.status now also accepts
-- 'awaiting_admin_submission' and 'invite_requested'. No schema change
-- because the column is text + app-side state-machine validation
-- (workers/contractingStateMachine.ts).
COMMENT ON COLUMN "carrier_contracting_requests"."status" IS
  'String-enum validated by workers/contractingStateMachine.ts. Allowed values: draft, paperwork_generated, signed, submitted, under_review, appointed, rejected, cancelled, awaiting_admin_submission, invite_requested.';
--> statement-breakpoint

COMMENT ON COLUMN "agent_onboarding_runs"."poa_status" IS
  'POA decision state: not_applicable (legacy / pre-decision), pending (envelope created, awaiting signature), signed (POA signed; INSUREitALL authorized), opted_out (agent declined POA; manual carrier-invite path).';
