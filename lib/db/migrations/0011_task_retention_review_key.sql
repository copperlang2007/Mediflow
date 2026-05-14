-- HIPAA retention compliance fix: deduplicate retention review tasks
-- by a deterministic per-(entity, phase) key instead of by human title.
--
-- The retention-enforcement worker previously checked for an existing
-- open task using the rendered title (e.g. `Retention review required:
-- agent "John Smith"`). Two distinct agents in the same org with the
-- same first/last name would collide on that title: the second agent
-- never got a review task. When the reviewer resolved the first task,
-- the next sweep proceeded to hard-delete BOTH agents — only one was
-- actually reviewed. That is a regulator-visible compliance gap.
--
-- This migration adds a `retention_review_key` column that the worker
-- populates with `${entityType}:${entityId}:${phase}` and creates a
-- partial unique index on `(org_id, retention_review_key)`. The worker
-- then uses `ON CONFLICT DO NOTHING` against that index for idempotency,
-- so a re-run cannot ever create two review tasks for the same entity
-- in the same phase. Non-retention tasks leave the column NULL and the
-- partial index ignores them.

ALTER TABLE "task_instances"
  ADD COLUMN IF NOT EXISTS "retention_review_key" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "task_instances_retention_review_key_unique"
  ON "task_instances" ("org_id", "retention_review_key")
  WHERE "retention_review_key" IS NOT NULL;
