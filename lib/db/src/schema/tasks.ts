import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable } from "./agents";

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "in_progress",
  "completed",
  "cancelled",
]);

export const taskPriorityEnum = pgEnum("task_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const checklistRunTypeEnum = pgEnum("checklist_run_type", [
  "onboarding",
  "offboarding",
]);

export const checklistRunStatusEnum = pgEnum("checklist_run_status", [
  "in_progress",
  "completed",
]);

export const checklistItemStatusEnum = pgEnum("checklist_item_status", [
  "pending",
  "completed",
  "skipped",
]);

export const taskTemplatesTable = pgTable("task_templates", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  title: text("title").notNull().default(""),
  description: text("description"),
  type: text("type").notNull().default("custom"),
  priority: taskPriorityEnum("priority").notNull().default("medium"),
  triggerEvent: text("trigger_event"),
  dueDaysFromTrigger: integer("due_days_from_trigger"),
  isActive: boolean("is_active").notNull().default(true),
  steps: jsonb("steps"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TaskTemplate = typeof taskTemplatesTable.$inferSelect;

export const taskInstancesTable = pgTable(
  "task_instances",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    templateId: text("template_id"),
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    contactId: text("contact_id"),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    assignedTo: text("assigned_to"),
    assignedToUserId: text("assigned_to_user_id"),
    status: taskStatusEnum("status").notNull().default("open"),
    priority: taskPriorityEnum("priority").notNull().default("medium"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    // Trigger event that spawned this row when the task was auto-created
    // by the taskAutoAssign worker (e.g. "agent_created",
    // "agent_status_changed"). NULL for manually-created tasks. Used by
    // the partial unique index `task_instances_auto_assign_unique` to
    // make worker retries idempotent on (agent_id, template_id, trigger).
    autoAssignTrigger: text("auto_assign_trigger"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("task_instances_org_id_status_idx").on(t.orgId, t.status),
    index("task_instances_org_id_due_date_idx").on(t.orgId, t.dueDate),
    index("task_instances_assigned_to_user_idx").on(t.assignedToUserId),
    uniqueIndex("task_instances_auto_assign_unique")
      .on(t.agentId, t.templateId, t.autoAssignTrigger)
      .where(
        sql`${t.templateId} IS NOT NULL AND ${t.agentId} IS NOT NULL AND ${t.autoAssignTrigger} IS NOT NULL`,
      ),
  ],
);

export const insertTaskInstanceSchema = createInsertSchema(
  taskInstancesTable
).omit({ createdAt: true, updatedAt: true });
export type InsertTaskInstance = z.infer<typeof insertTaskInstanceSchema>;
export type TaskInstance = typeof taskInstancesTable.$inferSelect;

export const checklistRunsTable = pgTable("checklist_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  type: checklistRunTypeEnum("type").notNull(),
  status: checklistRunStatusEnum("status").notNull().default("in_progress"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: text("completed_by"),
});

export type ChecklistRun = typeof checklistRunsTable.$inferSelect;

export const checklistItemsTable = pgTable("checklist_items", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => checklistRunsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  required: boolean("required").notNull().default(true),
  orderIndex: integer("order_index").notNull().default(0),
  status: checklistItemStatusEnum("status").notNull().default("pending"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: text("completed_by_user_id"),
  notes: text("notes"),
});

export type ChecklistItem = typeof checklistItemsTable.$inferSelect;
