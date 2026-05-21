-- Day 3: track the admin user who started an onboarding run so we can
-- assign the "Review and request contracting" admin task back to them
-- when the run hits `carriers_selected`. No backfill — no prod data on
-- the table yet (Day 1-2 just shipped the schema).
--
-- Also adds a deterministic dedup key column on task_instances for the
-- contracting orchestration. We reuse the same partial-unique-index idiom
-- as `task_instances_auto_assign_unique` (PR #75 / migration 0010) so
-- retries / double-clicks of a contracting step never duplicate tasks.
--
-- Why a new column rather than overloading `auto_assign_trigger`?
--   `auto_assign_trigger` is keyed against (agent_id, template_id,
--   auto_assign_trigger). Contracting tasks don't have a template_id —
--   they're generated inline by route handlers, not by the
--   taskAutoAssign worker. A separate column avoids forcing a synthetic
--   template_id on every row and keeps the two idempotency domains
--   independent.

ALTER TABLE "agent_onboarding_runs"
  ADD COLUMN IF NOT EXISTS "started_by_user_id" text;
--> statement-breakpoint

ALTER TABLE "task_instances"
  ADD COLUMN IF NOT EXISTS "contracting_task_key" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "task_instances_contracting_task_key_unique"
  ON "task_instances" ("org_id", "contracting_task_key")
  WHERE "contracting_task_key" IS NOT NULL;
