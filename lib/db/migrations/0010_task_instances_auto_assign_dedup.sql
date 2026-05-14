-- Idempotency for the task auto-assignment worker.
--
-- The worker fires when an agent is created or its status changes, then
-- bulk-inserts one task per matching task_template. pg-boss retries the
-- job on any non-success outcome (worker crash, transient DB error,
-- visibility-timeout expiry), and the original implementation re-loaded
-- the same templates and inserted them again — agents would see the
-- same auto-assigned task two, three, or N times.
--
-- Fix: dedupe by (agent_id, template_id, auto_assign_trigger). The
-- invariant is "at most one auto-created task per
-- (agent, template, trigger) tuple"; operators who want a duplicate task
-- can clone the template. The auto_assign_trigger column captures which
-- trigger event spawned the row so distinct triggers (e.g. agent_created
-- vs. agent_status_changed) remain free to each create their own task.
--
-- A partial unique index (rather than a plain unique constraint) keeps
-- manually-created tasks unaffected: those have NULL template_id,
-- NULL agent_id, or both, and the index ignores them.

ALTER TABLE "task_instances"
  ADD COLUMN IF NOT EXISTS "auto_assign_trigger" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "task_instances_auto_assign_unique"
  ON "task_instances" ("agent_id", "template_id", "auto_assign_trigger")
  WHERE "template_id" IS NOT NULL
    AND "agent_id" IS NOT NULL
    AND "auto_assign_trigger" IS NOT NULL;
