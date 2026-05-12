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
-- 0003_commissions.sql is `CONSTRAINT missed_payment_alerts_unique
-- UNIQUE (…)` — a table-level UNIQUE constraint, not a free-standing
-- index — so we drop the constraint and re-add it with the new clause.
-- Idempotent so it can re-run safely on prod.

ALTER TABLE "missed_payment_alerts"
  DROP CONSTRAINT IF EXISTS "missed_payment_alerts_unique";
--> statement-breakpoint
ALTER TABLE "missed_payment_alerts"
  ADD CONSTRAINT "missed_payment_alerts_unique"
  UNIQUE NULLS NOT DISTINCT ("org_id", "contact_id", "policy_number", "expected_period");
