-- Idempotency for commission reconciliation.
--
-- `reconcileStatement` walks every line item on a statement and adds the
-- computed split deltas to `agent_commission_payouts.earned`. Without a
-- record of "did this line item already contribute to the payout?" each
-- re-invocation (operator double-click, pg-boss retry, statement re-upload)
-- compounds the credits and over-pays agents.
--
-- We snapshot the contribution per line item as JSONB so we can:
--   1. Skip the upsert when the new computed splits are identical to the
--      stored snapshot (true idempotent re-run).
--   2. Apply only the DIFFERENCE per agent when splits change between runs
--      (manual contact re-assignment, hierarchy edit, etc.).
--   3. Reverse credits cleanly when a chargeback flips amount sign.
--
-- Shape: { writingAgentId, periodStart, periodEnd, splits: [{ agentId, amount }] }
ALTER TABLE "commission_line_items"
  ADD COLUMN IF NOT EXISTS "payout_contribution" jsonb;
