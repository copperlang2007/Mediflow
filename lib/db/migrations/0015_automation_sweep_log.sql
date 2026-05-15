-- Replay guard for the daily automation sweep worker.
--
-- The sweep (`weeklyAutomationSweep.ts`) scans every org for time-based
-- triggers (license/cert expiry, AHIP deadlines, contact-no-activity,
-- task-overdue, scheduled, enrollment-period-opens) and enqueues a
-- `run-automation-rules` job per matching record. pg-boss redelivers the
-- whole sweep job on any non-success outcome (worker crash, pg-boss
-- connection drop, visibility-timeout expiry). The original
-- implementation re-scanned and re-enqueued the ENTIRE batch on every
-- retry.
--
-- The downstream `runAutomationRules` worker is NOT idempotent: it
-- unconditionally inserts notification rows, auto-creates tasks, writes
-- automation_rule_logs rows, and re-enqueues emails/SMS. So a sweep
-- replay after enqueuing (say) 50 of 100 license expiries re-fires
-- automation rules and duplicate alerts for the 50 already processed.
--
-- Fix: a per-record idempotency log. Before enqueuing for a record the
-- sweep does `INSERT ... ON CONFLICT DO NOTHING` into this table and
-- only enqueues if the insert claimed the row. The dedup key is
-- (org_id, sweep_type, resource_id, sweep_run_date) — `sweep_run_date`
-- is the calendar date (UTC) the sweep runs, so a same-day retry
-- collapses onto the existing claim while next day's run is a distinct
-- key and re-fires as intended. The table also doubles as an audit
-- trail of exactly what the sweep enqueued and when.

CREATE TABLE IF NOT EXISTS "automation_sweep_log" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sweep_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "sweep_run_date" text NOT NULL,
  "swept_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "automation_sweep_log_claim_unique"
  ON "automation_sweep_log" ("org_id", "sweep_type", "resource_id", "sweep_run_date");
