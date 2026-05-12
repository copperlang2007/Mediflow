import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  real,
  pgEnum,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable, carriersTable } from "./agents";

export const contactStatusEnum = pgEnum("contact_status", [
  "lead",
  "prospect",
  "enrolled",
  "retained",
  "lost",
  "do_not_contact",
]);

export const planTypeEnum = pgEnum("plan_type", ["MA", "PDP", "MAPD", "supp", "other"]);

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
]);

export const dealStatusEnum = pgEnum("deal_status", ["open", "won", "lost"]);

// `bytea` column type. Drizzle pg-core ships `text`/`integer`/etc. as
// first-class, but bytea isn't built in yet — declare it once and reuse.
// Reads return a Node Buffer (node-postgres) or Uint8Array (pglite); both
// are accepted by the encryption helpers in lib/db/src/encryption/.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const activityTypeEnum = pgEnum("activity_type", [
  "note",
  "call_log",
  "sms",
  "email",
  "status_change",
  "enrollment",
  "task_complete",
  "document_upload",
  "sequence_enrolled",
  "sequence_step",
]);

export const contactsTable = pgTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    assignedAgentId: text("assigned_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    dob: timestamp("dob", { withTimezone: true }),
    medicareId: text("medicare_id"),
    // HIPAA-2: column-level encryption for medicare_id. Both new columns
    // are populated alongside the plaintext during the dual-write window;
    // reads switch to them once `MEDICARE_ID_ENCRYPTION_ENABLED=true` and
    // the backfill script has run. See lib/db/src/encryption/medicareId.ts.
    medicareIdEncrypted: bytea("medicare_id_encrypted"),
    medicareIdHash: bytea("medicare_id_hash"),
    currentPlanType: planTypeEnum("current_plan_type"),
    currentCarrierId: text("current_carrier_id").references(
      () => carriersTable.id,
      { onDelete: "set null" }
    ),
    planYear: integer("plan_year"),
    county: text("county"),
    stateCode: text("state_code"),
    zipCode: text("zip_code"),
    preferredLanguage: text("preferred_language"),
    pcpName: text("pcp_name"),
    pcpNpi: text("pcp_npi"),
    healthConditions: text("health_conditions").array(),
    leadSource: text("lead_source"),
    status: contactStatusEnum("status").notNull().default("lead"),
    optOutSms: boolean("opt_out_sms").notNull().default(false),
    optOutEmail: boolean("opt_out_email").notNull().default(false),
    tags: text("tags").array(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("contacts_org_id_status_idx").on(t.orgId, t.status),
    index("contacts_org_id_assigned_agent_idx").on(t.orgId, t.assignedAgentId),
    index("contacts_org_id_deleted_at_idx").on(t.orgId, t.deletedAt),
  ],
);

export const insertContactSchema = createInsertSchema(contactsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;

export const leadsTable = pgTable(
  "leads",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contactsTable.id, { onDelete: "cascade" }),
    assignedAgentId: text("assigned_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    source: text("source"),
    sourceDetail: text("source_detail"),
    score: integer("score").notNull().default(0),
    status: leadStatusEnum("status").notNull().default("new"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("leads_org_id_status_idx").on(t.orgId, t.status),
    index("leads_org_id_assigned_agent_idx").on(t.orgId, t.assignedAgentId),
  ],
);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;

export const pipelinesTable = pgTable("pipelines", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  description: text("description"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Pipeline = typeof pipelinesTable.$inferSelect;

export const pipelineStagesTable = pgTable("pipeline_stages", {
  id: text("id").primaryKey(),
  pipelineId: text("pipeline_id")
    .notNull()
    .references(() => pipelinesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  orderIndex: integer("order_index").notNull().default(0),
  color: text("color").notNull().default("#6366f1"),
  probabilityPct: integer("probability_pct").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PipelineStage = typeof pipelineStagesTable.$inferSelect;

export const dealsTable = pgTable("deals", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  pipelineId: text("pipeline_id")
    .notNull()
    .references(() => pipelinesTable.id),
  stageId: text("stage_id")
    .notNull()
    .references(() => pipelineStagesTable.id),
  contactId: text("contact_id")
    .notNull()
    .references(() => contactsTable.id, { onDelete: "cascade" }),
  assignedAgentId: text("assigned_agent_id").references(() => agentsTable.id, {
    onDelete: "set null",
  }),
  title: text("title").notNull(),
  valueEst: real("value_est"),
  status: dealStatusEnum("status").notNull().default("open"),
  wonAt: timestamp("won_at", { withTimezone: true }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  lostReason: text("lost_reason"),
  closeDateEst: timestamp("close_date_est", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Deal = typeof dealsTable.$inferSelect;

export const dealStageHistoryTable = pgTable("deal_stage_history", {
  id: text("id").primaryKey(),
  dealId: text("deal_id")
    .notNull()
    .references(() => dealsTable.id, { onDelete: "cascade" }),
  fromStageId: text("from_stage_id"),
  toStageId: text("to_stage_id")
    .notNull()
    .references(() => pipelineStagesTable.id),
  changedByUserId: text("changed_by_user_id"),
  changedAt: timestamp("changed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DealStageHistory = typeof dealStageHistoryTable.$inferSelect;

export const activitiesTable = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id").references(() => contactsTable.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    dealId: text("deal_id"),
    taskId: text("task_id"),
    type: activityTypeEnum("type").notNull(),
    body: text("body"),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("activities_org_id_created_at_idx").on(t.orgId, t.createdAt),
    index("activities_contact_id_idx").on(t.contactId),
  ],
);

export const insertActivitySchema = createInsertSchema(activitiesTable).omit({
  createdAt: true,
});
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activitiesTable.$inferSelect;
