import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./core";

/**
 * HIPAA breach notification ledger.
 *
 * Each row represents a suspected or confirmed PHI breach event for an
 * organization, including detection metadata, severity, notification posture,
 * and resolution state. The BAA checklist consumes this table to verify the
 * existence of an active breach-notification workflow.
 */
export const breachNotificationsTable = pgTable(
  "breach_notifications",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    detectedByUserId: text("detected_by_user_id"),
    detectedBySystem: text("detected_by_system"),
    affectedRecordType: text("affected_record_type").notNull(),
    affectedRecordCount: integer("affected_record_count").notNull(),
    description: text("description").notNull(),
    severity: text("severity").notNull().default("low"),
    status: text("status").notNull().default("open"),
    notificationRequired: boolean("notification_required").notNull().default(false),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifiedVia: jsonb("notified_via"),
    resolutionNotes: text("resolution_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("breach_notifications_org_status_idx").on(t.orgId, t.status),
    index("breach_notifications_org_detected_at_idx").on(t.orgId, t.detectedAt),
  ],
);

export type BreachNotification = typeof breachNotificationsTable.$inferSelect;
export type InsertBreachNotification = typeof breachNotificationsTable.$inferInsert;

export const BREACH_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];

export const BREACH_STATUSES = [
  "open",
  "investigating",
  "notified",
  "resolved",
  "false_positive",
] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];
