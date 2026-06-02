-- masterBRIDGE dialer integration (Option A, Phase 6) — reconciliation +
-- replay hardening (spec §5.4, §6, §10 Phase 6 row).
--
-- A dial ticket that never receives its terminal webhook (`call.completed` /
-- `call.failed`) would otherwise hang forever in a pre-terminal state. The
-- Phase-6 reconciliation job (§5.4) finds such stuck tickets, fetches the
-- authoritative state from the dialer's `GET /dialer/v1/calls/{id}`, and
-- applies the missed terminal outcome once. This migration adds the bookkeeping
-- column that records when an outcome was recovered by reconciliation (vs. by
-- the normal webhook), so MediFlow can audit the missed-webhook recovery rate.
--
--   * reconciled_at   timestamptz NULL
--                      Set when the terminal status was applied by the
--                      reconciliation job rather than the inbound webhook.
--                      NULL for tickets whose webhook delivered the outcome
--                      normally. The terminal status itself lives in the
--                      existing `status` column; the new pre-terminal value
--                      `CALLING` and terminal values `COMPLETED`/`FAILED` are
--                      not enumerated in the schema (status is free `text`),
--                      so no enum change is required.
--
-- Backwards-compatible: existing rows get NULL. No data migration needed.

ALTER TABLE "dial_tickets"
  ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;
--> statement-breakpoint

COMMENT ON COLUMN "dial_tickets"."reconciled_at" IS
  'Phase 6 (§5.4): set when the terminal call outcome was recovered by the reconciliation job (missed webhook) rather than delivered by the inbound webhook. NULL otherwise.';
--> statement-breakpoint

-- Reconciliation scans for stuck, pre-terminal tickets across orgs ordered by
-- staleness, so an index on (status, updated_at) keeps that scan cheap as the
-- table grows.
CREATE INDEX IF NOT EXISTS "dial_tickets_status_updated_at_idx"
  ON "dial_tickets" ("status", "updated_at");
