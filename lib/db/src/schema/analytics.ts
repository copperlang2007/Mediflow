import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable, usersTable } from "./core";

// ─── Login Events ────────────────────────────────────────────────────────────
export const loginEventsTable = pgTable(
  "login_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    email: text("email"),
    success: boolean("success").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("login_events_org_id_created_at_idx").on(t.orgId, t.createdAt),
    index("login_events_org_id_user_id_idx").on(t.orgId, t.userId),
    index("login_events_org_id_success_idx").on(t.orgId, t.success),
  ],
);
export type LoginEvent = typeof loginEventsTable.$inferSelect;

// ─── Data Export Log ──────────────────────────────────────────────────────────
export const dataExportLogTable = pgTable(
  "data_export_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    exportType: text("export_type").notNull(), // e.g. 'agent_performance_csv', 'soc2_evidence_pdf'
    filters: jsonb("filters"),
    recordCount: integer("record_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("data_export_log_org_id_created_at_idx").on(t.orgId, t.createdAt),
    index("data_export_log_org_id_user_id_idx").on(t.orgId, t.userId),
  ],
);
export type DataExportLog = typeof dataExportLogTable.$inferSelect;

// ─── Data Retention Policies ──────────────────────────────────────────────────
export const dataRetentionPoliciesTable = pgTable("data_retention_policies", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  recordType: text("record_type").notNull(), // 'contacts','agents','audit_log','communications','documents'
  retentionDays: integer("retention_days").notNull().default(2555), // ~7 years
  isEnabled: boolean("is_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedByUserId: text("updated_by_user_id"),
});
export type DataRetentionPolicy = typeof dataRetentionPoliciesTable.$inferSelect;

