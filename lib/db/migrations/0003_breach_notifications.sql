-- HIPAA Breach Notification workflow tracking.
-- Records suspected/confirmed breach events, severity, notification posture,
-- and resolution. Drives the BAA checklist's `breach_notification_workflow`
-- control and the export-anomaly alerting integration.

CREATE TABLE IF NOT EXISTS "breach_notifications" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "detected_at" timestamptz NOT NULL DEFAULT now(),
  "detected_by_user_id" text,
  "detected_by_system" text,
  "affected_record_type" text NOT NULL,
  "affected_record_count" integer NOT NULL,
  "description" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'low',
  "status" text NOT NULL DEFAULT 'open',
  "notification_required" boolean NOT NULL DEFAULT false,
  "notified_at" timestamptz,
  "notified_via" jsonb,
  "resolution_notes" text,
  "resolved_at" timestamptz,
  "resolved_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "breach_notifications_org_status_idx"
  ON "breach_notifications" ("org_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "breach_notifications_org_detected_at_idx"
  ON "breach_notifications" ("org_id", "detected_at");
