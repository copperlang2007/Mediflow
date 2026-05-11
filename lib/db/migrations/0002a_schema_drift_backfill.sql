-- Schema drift backfill.
--
-- Five tables and one column had been added to the Drizzle schema
-- (lib/db/src/schema/*.ts) without corresponding SQL migration entries.
-- Production has been kept in sync via `drizzle-kit push`, but a fresh
-- database built solely from migrations/*.sql diverged from the schema.
--
-- This migration brings the migration history in line with the Drizzle
-- definitions: org_settings, session_activity, login_events,
-- data_export_log, data_retention_policies, plus contacts.deleted_at
-- and deals.deleted_at.
--
-- IMPORTANT: every statement is idempotent so deploying against an
-- existing production DB (which already has these tables/columns from
-- `drizzle-kit push`) is a no-op rather than a hard failure.
--
-- Filename is 0002a_* (rather than 0004_*) so it sorts lexically before
-- 0003_perf_partial_indexes.sql, which creates partial indexes that
-- reference the deleted_at columns and would otherwise fail on a fresh DB.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_org_id_deleted_at_idx"
  ON "contacts" ("org_id", "deleted_at");
--> statement-breakpoint

-- Per-org configuration: AHIP season window, reminder cadence, session timeout.
CREATE TABLE IF NOT EXISTS "org_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ahip_season_open_month" integer NOT NULL DEFAULT 7,
  "ahip_season_open_day" integer NOT NULL DEFAULT 1,
  "ahip_deadline_month" integer NOT NULL DEFAULT 12,
  "ahip_deadline_day" integer NOT NULL DEFAULT 7,
  "ahip_reminder_enabled" boolean NOT NULL DEFAULT true,
  "ahip_reminder_interval_weeks" integer NOT NULL DEFAULT 2,
  "session_timeout_minutes" integer NOT NULL DEFAULT 30
);
--> statement-breakpoint

-- Durable per-session inactivity tracking. Authoritative source for session
-- timeouts so restarts can't bypass the process-local Map.
CREATE TABLE IF NOT EXISTS "session_activity" (
  "session_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "last_active_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_activity_org_id_idx"
  ON "session_activity" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_activity_expires_at_idx"
  ON "session_activity" ("expires_at");
--> statement-breakpoint

-- Login event audit trail (success & failure).
CREATE TABLE IF NOT EXISTS "login_events" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "email" text,
  "success" boolean NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "failure_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_events_org_id_created_at_idx"
  ON "login_events" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_events_org_id_user_id_idx"
  ON "login_events" ("org_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_events_org_id_success_idx"
  ON "login_events" ("org_id", "success");
--> statement-breakpoint

-- Data export audit log (CSV/PDF exports for SOC 2 evidence).
CREATE TABLE IF NOT EXISTS "data_export_log" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "export_type" text NOT NULL,
  "filters" jsonb,
  "record_count" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_export_log_org_id_created_at_idx"
  ON "data_export_log" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_export_log_org_id_user_id_idx"
  ON "data_export_log" ("org_id", "user_id");
--> statement-breakpoint

-- Per-record-type retention policies (e.g. contacts 7y, audit_log 7y).
CREATE TABLE IF NOT EXISTS "data_retention_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "record_type" text NOT NULL,
  "retention_days" integer NOT NULL DEFAULT 2555,
  "is_enabled" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_user_id" text
);
