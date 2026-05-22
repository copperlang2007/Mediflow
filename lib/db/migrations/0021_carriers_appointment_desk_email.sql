-- Day-6 contracting email-out worker — adds the per-carrier
-- appointment-desk email address (+ per-carrier submission metadata
-- escape hatch) that the worker reads when dispatching signed packets.
--
-- Two columns:
--
--   appointment_desk_email    — text. NULL is permitted: INSUREitALL is
--                               populating these incrementally and the
--                               worker WARN-logs + leaves the submit task
--                               open until a real address lands. That way
--                               we can ship the code path now without
--                               waiting for every carrier's address.
--
--   appointment_desk_metadata — jsonb default '{}'. Loosely typed bag for
--                               per-carrier submission overrides: an
--                               optional `cc` list (string[]), a `subject`
--                               template, anything else INSUREitALL needs
--                               to tweak without a schema change. The worker
--                               reads documented keys and ignores the rest.
--
-- No backfill needed — the column is nullable and any existing carriers
-- rows will simply not trigger email-out until an admin sets the address
-- via the PATCH /carriers/:id route (Day-6 PR).
--
-- Idempotent: every ALTER uses IF NOT EXISTS.

ALTER TABLE "carriers"
  ADD COLUMN IF NOT EXISTS "appointment_desk_email" text;
--> statement-breakpoint

ALTER TABLE "carriers"
  ADD COLUMN IF NOT EXISTS "appointment_desk_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;
