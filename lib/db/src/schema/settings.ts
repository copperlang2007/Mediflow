import { pgTable, text, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./core";

export const orgSettingsTable = pgTable("org_settings", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .unique()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  ahipSeasonOpenMonth: integer("ahip_season_open_month").notNull().default(7),
  ahipSeasonOpenDay: integer("ahip_season_open_day").notNull().default(1),
  ahipDeadlineMonth: integer("ahip_deadline_month").notNull().default(12),
  ahipDeadlineDay: integer("ahip_deadline_day").notNull().default(7),
  ahipReminderEnabled: boolean("ahip_reminder_enabled").notNull().default(true),
  ahipReminderIntervalWeeks: integer("ahip_reminder_interval_weeks").notNull().default(2),
  // Automated SMS only goes to contacts with a recorded TCPA consent (0050).
  requireSmsConsent: boolean("require_sms_consent").notNull().default(true),
  sessionTimeoutMinutes: integer("session_timeout_minutes").notNull().default(30),
});

export type OrgSettings = typeof orgSettingsTable.$inferSelect;

/**
 * Durable per-session inactivity tracking.
 * Each authenticated request upserts the session's last-active timestamp.
 * On restart, this table is the authoritative source of truth for timeouts,
 * eliminating the process-local Map bypass risk identified for HIPAA/SOC 2.
 */
export const sessionActivityTable = pgTable(
  "session_activity",
  {
    sessionId: text("session_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("session_activity_org_id_idx").on(t.orgId),
    index("session_activity_expires_at_idx").on(t.expiresAt),
  ],
);

export type SessionActivity = typeof sessionActivityTable.$inferSelect;
