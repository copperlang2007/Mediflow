-- Idempotency ledger for the `sendSequenceStep` worker.
--
-- pg-boss retries a job on crash/timeout, and the worker's side effect
-- (enqueue Twilio SMS, enqueue Resend email, insert task row) used to
-- run BEFORE the enrollment pointer was advanced. A retry between
-- those two writes re-fired the side effect — duplicate texts billed
-- through Twilio, duplicate follow-up tasks created on the agent.
--
-- The worker now claims a (enrollment_id, step_index) slot in this
-- ledger via INSERT ... ON CONFLICT DO NOTHING before firing the side
-- effect; on retry the conflict means "already done — skip and just
-- advance the pointer."
--
-- enrollment_id matches `sequence_enrollments.id`, which is text in
-- this codebase (NOT uuid). ON DELETE CASCADE so purging an enrollment
-- drops its ledger entries.

CREATE TABLE IF NOT EXISTS "sequence_step_executions" (
  "enrollment_id" text NOT NULL REFERENCES "sequence_enrollments"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  "side_effect" text NOT NULL,
  "executed_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("enrollment_id", "step_index")
);
