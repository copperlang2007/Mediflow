-- When a commission statement was last reconciled.
--
-- The statement detail page showed "Last reconciled —" on statements whose
-- status was 'reconciled': nothing recorded the time. The reconcile worker
-- now stamps this column in the same transaction that sets the status.
-- Rows reconciled before this migration keep NULL (the time was never
-- recorded, and guessing it from created_at would be a made-up date); the UI
-- says "Not recorded" for those.
ALTER TABLE "commission_statements" ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;
