-- Fixes the missed_payment_alerts idempotency bug that PR #49's test
-- suite caught with a skipped test.
--
-- The unique constraint covers (org_id, contact_id, policy_number,
-- expected_period). commissionMissedPaymentCheckWorker always inserts
-- policy_number = NULL when it doesn't have a real policy number on
-- hand, and Postgres treats NULLs as distinct in unique indexes by
-- default — so `.onConflictDoNothing()` never fired and every nightly
-- cron run double-inserted the same alerts.
--
-- Postgres 15+ supports NULLS NOT DISTINCT, which treats NULLs as
-- equal for uniqueness purposes. The original constraint in
-- 0003_commissions.sql is a table-level UNIQUE constraint (not a free-
-- standing index), so we drop the constraint and re-add it with the
-- new clause.
--
-- BEFORE re-adding the constraint we MUST de-duplicate any existing
-- rows that the buggy cron has already double-inserted. Otherwise the
-- ADD CONSTRAINT statement fails with
--   "could not create unique index ... key (..., NULL, ...) is duplicated"
-- on real production data. The DELETE keeps the oldest row per unique
-- tuple (smallest id) — that's the original alert the cron raised; the
-- duplicates are later runs that should have been no-ops.
--
-- Idempotent so it can re-run safely.

ALTER TABLE "missed_payment_alerts"
  DROP CONSTRAINT IF EXISTS "missed_payment_alerts_unique";
--> statement-breakpoint

-- Collapse duplicates introduced by the bug. IS NOT DISTINCT FROM does
-- NULL-safe comparison so NULL policy_numbers cluster correctly.
DELETE FROM "missed_payment_alerts" a
USING "missed_payment_alerts" b
WHERE a.id > b.id
  AND a.org_id = b.org_id
  AND a.contact_id = b.contact_id
  AND a.policy_number IS NOT DISTINCT FROM b.policy_number
  AND a.expected_period IS NOT DISTINCT FROM b.expected_period;
--> statement-breakpoint

ALTER TABLE "missed_payment_alerts"
  ADD CONSTRAINT "missed_payment_alerts_unique"
  UNIQUE NULLS NOT DISTINCT ("org_id", "contact_id", "policy_number", "expected_period");
