-- Idempotency for inbound provider webhooks (Twilio retries duplicate
-- deliveries on any non-2xx response, and occasionally on success when
-- their ACK times out). Enforce uniqueness on the provider-supplied
-- message id so retries collapse to a single row.
--
-- Partial index: outbound messages don't carry a provider id at insert
-- time (assigned later when the delivery callback arrives, if at all),
-- so NULL rows must remain free of the constraint.

-- Schema-drift backfill: `messages.ai_assisted` is declared in the
-- Drizzle schema (lib/db/src/schema/communications.ts) but was never
-- emitted into the SQL migration history. Production has it via
-- `drizzle-kit push`, but a fresh DB built solely from migrations/*.sql
-- is missing it — and Drizzle's generated INSERT/SELECT statements
-- reference the column unconditionally, so anything touching `messages`
-- on a fresh DB fails. Add it here (idempotent) before the index so the
-- partial unique index can be created on the now-correct table shape.
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "ai_assisted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "messages_provider_message_id_unique"
  ON "messages" ("provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
