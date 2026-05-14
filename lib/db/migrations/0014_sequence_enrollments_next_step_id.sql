-- Sequence enrollments: switch the "what step runs next" pointer from
-- a positional index into the steps list to the stable step ID.
--
-- Background: `sequence_enrollments.next_step_index` is an integer offset
-- into a list of `sequence_steps` ordered by `order_index`. The
-- `sendSequenceStep` worker re-loads that list on every run and picks
-- `steps[next_step_index]`. That means an operator deleting,
-- reordering, or inserting a step on a sequence with in-flight
-- enrollments silently shifts every enrollment's pointer to a
-- DIFFERENT logical step — wrong-content emails / SMS / tasks fire.
--
-- This migration adds `next_step_id text` as the authoritative pointer,
-- with a FK to `sequence_steps(id)` and `ON DELETE SET NULL`. When the
-- referenced step is deleted, the column nulls out and the worker can
-- detect the dangling state on the next run and gracefully complete the
-- enrollment.
--
-- `next_step_index` is RETAINED (not dropped) for one deploy cycle as a
-- historical / rollback-safe field. The worker no longer reads it for
-- routing once this migration is applied. Drop is a follow-up.
--
-- Backfill: for every currently-active enrollment whose `next_step_id`
-- is still NULL, set it to the id of the step at offset
-- `next_step_index` in its sequence's `order_index`-sorted step list.
-- Enrollments in any other status are not backfilled — they won't be
-- processed by the worker again, so the pointer is moot.

ALTER TABLE "sequence_enrollments"
  ADD COLUMN IF NOT EXISTS "next_step_id" text;
--> statement-breakpoint

ALTER TABLE "sequence_enrollments"
  DROP CONSTRAINT IF EXISTS "sequence_enrollments_next_step_id_fkey";
--> statement-breakpoint

ALTER TABLE "sequence_enrollments"
  ADD CONSTRAINT "sequence_enrollments_next_step_id_fkey"
  FOREIGN KEY ("next_step_id")
  REFERENCES "sequence_steps" ("id")
  ON DELETE SET NULL;
--> statement-breakpoint

UPDATE "sequence_enrollments" e
SET "next_step_id" = (
  SELECT s."id"
  FROM "sequence_steps" s
  WHERE s."sequence_id" = e."sequence_id"
  ORDER BY s."order_index"
  OFFSET e."next_step_index"
  LIMIT 1
)
WHERE e."next_step_id" IS NULL
  AND e."status" = 'active';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sequence_enrollments_next_step_id_idx"
  ON "sequence_enrollments" ("next_step_id");
