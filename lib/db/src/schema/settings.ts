import { pgTable, text, boolean, integer } from "drizzle-orm/pg-core";
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
  sessionTimeoutMinutes: integer("session_timeout_minutes").notNull().default(30),
});

export type OrgSettings = typeof orgSettingsTable.$inferSelect;
