import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  primaryKey,
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
  // `next_step_index` is the legacy positional pointer; retained for one
  // deploy cycle for rollback safety. The worker now routes via
  // `next_step_id`; positional lookup is only used as a back-compat
  // fallback for in-flight pg-boss jobs whose payload predates the
  // stepId field. See migration 0014.
  nextStepIndex: integer("next_step_index").notNull().default(0),
  // Authoritative pointer at the next step to execute. FK with
  // ON DELETE SET NULL so that operator-deleting a step leaves the
  // enrollment in a known-broken state (the worker completes it
  // gracefully on the next run) rather than dangling.
  nextStepId: text("next_step_id").references(() => sequenceStepsTable.id, {
    onDelete: "set null",
  }),
  nextStepAt: timestamp("next_step_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SequenceEnrollment = typeof sequenceEnrollmentsTable.$inferSelect;

/**
 * Side-effect execution log for sequence steps. Acts as an idempotency
 * ledger for the `sendSequenceStep` worker: the worker claims a
 * (enrollment_id, step_index) row inside an `INSERT ... ON CONFLICT DO
 * NOTHING` before firing any external side effect (email/sms enqueue,
 * task insert). On pg-boss retry after a side effect has run but before
 * the enrollment pointer advance committed, the conflict makes the
 * worker skip the side effect — preventing duplicate Twilio sends,
 * Resend emails, and duplicate follow-up task rows.
 *
 * DELETE CASCADE on enrollment_id so purging an enrollment drops its
 * ledger entries too.
 */
export const sequenceStepExecutionsTable = pgTable("sequence_step_executions", {
  enrollmentId: text("enrollment_id")
    .notNull()
    .references(() => sequenceEnrollmentsTable.id, { onDelete: "cascade" }),
  stepIndex: integer("step_index").notNull(),
  sideEffect: text("side_effect").notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.enrollmentId, t.stepIndex] }),
]);

export type SequenceStepExecution =
  typeof sequenceStepExecutionsTable.$inferSelect;

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
