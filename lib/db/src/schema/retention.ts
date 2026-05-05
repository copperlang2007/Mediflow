import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./core";
import { usersTable } from "./core";
import { contactsTable } from "./crm";

export const retentionFlagTypeEnum = pgEnum("retention_flag_type", [
  "at_risk",
  "anniversary_due",
  "birthday_soon",
  "aep_eligible",
  "oep_eligible",
]);

export const importSourceEnum = pgEnum("import_source", [
  "monday",
  "ghl",
  "csv",
]);

export const importStatusEnum = pgEnum("import_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const retentionFlagsTable = pgTable("retention_flags", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  contactId: text("contact_id")
    .notNull()
    .references(() => contactsTable.id, { onDelete: "cascade" }),
  flagType: retentionFlagTypeEnum("flag_type").notNull(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RetentionFlag = typeof retentionFlagsTable.$inferSelect;

export const importJobsTable = pgTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    importType: text("import_type").notNull().default("csv_contacts"),
    status: text("status").notNull().default("pending"),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    errors: jsonb("errors"),
    columnMapping: jsonb("column_mapping"),
    options: jsonb("options"),
    fileName: text("file_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("import_jobs_org_id_created_at_idx").on(t.orgId, t.createdAt),
    index("import_jobs_org_id_status_idx").on(t.orgId, t.status),
  ],
);

export type ImportJob = typeof importJobsTable.$inferSelect;
