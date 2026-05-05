import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { contactsTable } from "./crm";

export const sequenceStatusEnum = pgEnum("sequence_status", [
  "active",
  "paused",
  "draft",
]);
export const sequenceTriggerTypeEnum = pgEnum("sequence_trigger_type", [
  "manual",
  "lead_created",
  "enrolled",
  "birthday",
  "plan_anniversary",
  "aep_start",
  "oep_start",
  "custom_date",
]);
export const sequenceStepTypeEnum = pgEnum("sequence_step_type", [
  "sms",
  "email",
  "task",
  "wait",
]);
export const sequenceEnrollmentStatusEnum = pgEnum(
  "sequence_enrollment_status",
  ["active", "completed", "cancelled", "paused"]
);
export const automationResultEnum = pgEnum("automation_result", [
  "success",
  "partial",
  "failed",
]);

export const sequencesTable = pgTable("sequences", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  description: text("description"),
  triggerType: sequenceTriggerTypeEnum("trigger_type").notNull().default("manual"),
  triggerConfig: jsonb("trigger_config"),
  status: sequenceStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Sequence = typeof sequencesTable.$inferSelect;

export const sequenceStepsTable = pgTable("sequence_steps", {
  id: text("id").primaryKey(),
  sequenceId: text("sequence_id")
    .notNull()
    .references(() => sequencesTable.id, { onDelete: "cascade" }),
  orderIndex: integer("order_index").notNull().default(0),
  stepType: sequenceStepTypeEnum("step_type").notNull(),
  delayValue: integer("delay_value").notNull().default(0),
  delayUnit: text("delay_unit").notNull().default("days"),
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SequenceStep = typeof sequenceStepsTable.$inferSelect;

export const sequenceEnrollmentsTable = pgTable("sequence_enrollments", {
  id: text("id").primaryKey(),
  sequenceId: text("sequence_id")
    .notNull()
    .references(() => sequencesTable.id, { onDelete: "cascade" }),
  contactId: text("contact_id")
    .notNull()
    .references(() => contactsTable.id, { onDelete: "cascade" }),
  status: sequenceEnrollmentStatusEnum("status").notNull().default("active"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  nextStepIndex: integer("next_step_index").notNull().default(0),
  nextStepAt: timestamp("next_step_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SequenceEnrollment = typeof sequenceEnrollmentsTable.$inferSelect;

export const automationRulesTable = pgTable("automation_rules", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config"),
  conditions: jsonb("conditions"),
  actions: jsonb("actions"),
  isActive: boolean("is_active").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  runCount: integer("run_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertAutomationRuleSchema = createInsertSchema(
  automationRulesTable
).omit({ createdAt: true, updatedAt: true });
export type InsertAutomationRule = z.infer<typeof insertAutomationRuleSchema>;
export type AutomationRule = typeof automationRulesTable.$inferSelect;

export const automationRuleLogsTable = pgTable("automation_rule_logs", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id")
    .notNull()
    .references(() => automationRulesTable.id, { onDelete: "cascade" }),
  triggerEvent: text("trigger_event"),
  matchedRecordType: text("matched_record_type"),
  matchedRecordId: text("matched_record_id"),
  actionsExecuted: jsonb("actions_executed"),
  result: automationResultEnum("result").notNull(),
  errorMessage: text("error_message"),
  executedAt: timestamp("executed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AutomationRuleLog = typeof automationRuleLogsTable.$inferSelect;
