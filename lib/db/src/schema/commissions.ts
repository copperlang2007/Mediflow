import {
  pgTable,
  text,
  timestamp,
  integer,
  date,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable, carriersTable } from "./agents";
import { contactsTable } from "./crm";

/**
 * Rate cards: how much carrier X pays for plan_type Y in cert year Z.
 * Either a percent grid (initial/renewal) or a flat amount may be set.
 */
export const commissionSchedulesTable = pgTable(
  "commission_schedules",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriersTable.id),
    planType: text("plan_type").notNull(),
    contractYear: integer("contract_year").notNull(),
    initialPct: numeric("initial_pct", { precision: 6, scale: 3 }),
    renewalPct: numeric("renewal_pct", { precision: 6, scale: 3 }),
    flatAmount: numeric("flat_amount", { precision: 10, scale: 2 }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("commission_schedules_org_carrier_idx").on(
      t.orgId,
      t.carrierId,
      t.contractYear,
    ),
  ],
);

export const insertCommissionScheduleSchema = createInsertSchema(
  commissionSchedulesTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertCommissionSchedule = z.infer<
  typeof insertCommissionScheduleSchema
>;
export type CommissionSchedule = typeof commissionSchedulesTable.$inferSelect;

/**
 * Splits: writing agent → upline % grid (effective-dated).
 */
export const commissionHierarchiesTable = pgTable(
  "commission_hierarchies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    writingAgentId: text("writing_agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    uplineAgentId: text("upline_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    splitPct: numeric("split_pct", { precision: 5, scale: 2 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("commission_hierarchies_writing_agent_idx").on(
      t.orgId,
      t.writingAgentId,
    ),
    uniqueIndex("commission_hierarchies_unique").on(
      t.orgId,
      t.writingAgentId,
      t.uplineAgentId,
      t.effectiveFrom,
    ),
  ],
);

export const insertCommissionHierarchySchema = createInsertSchema(
  commissionHierarchiesTable,
).omit({ createdAt: true });
export type InsertCommissionHierarchy = z.infer<
  typeof insertCommissionHierarchySchema
>;
export type CommissionHierarchy =
  typeof commissionHierarchiesTable.$inferSelect;

/**
 * A statement file uploaded from a carrier.
 */
export const commissionStatementsTable = pgTable(
  "commission_statements",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriersTable.id),
    statementDate: date("statement_date").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
    source: text("source").notNull(),
    storageKey: text("storage_key"),
    status: text("status").notNull(),
    uploadedByUserId: text("uploaded_by_user_id"),
    /** Set by the reconcile worker each time the statement is reconciled (0058). */
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("commission_statements_org_idx").on(t.orgId, t.statementDate)],
);

export const insertCommissionStatementSchema = createInsertSchema(
  commissionStatementsTable,
).omit({ createdAt: true });
export type InsertCommissionStatement = z.infer<
  typeof insertCommissionStatementSchema
>;
export type CommissionStatement =
  typeof commissionStatementsTable.$inferSelect;

/**
 * One row per (contact, period) on the statement.
 */
export const commissionLineItemsTable = pgTable(
  "commission_line_items",
  {
    id: text("id").primaryKey(),
    statementId: text("statement_id")
      .notNull()
      .references(() => commissionStatementsTable.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id").references(() => contactsTable.id),
    memberId: text("member_id"),
    policyNumber: text("policy_number"),
    planType: text("plan_type"),
    planYear: integer("plan_year"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    premium: numeric("premium", { precision: 10, scale: 2 }),
    commissionAmount: numeric("commission_amount", {
      precision: 10,
      scale: 2,
    }).notNull(),
    type: text("type").notNull(),
    writingAgentId: text("writing_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    matchStatus: text("match_status").notNull().default("unmatched"),
    raw: jsonb("raw"),
    /**
     * Snapshot of the splits this line item has already contributed to
     * `agent_commission_payouts.earned`. Used by the reconcile worker to
     * stay idempotent across retries / re-runs and to apply only the
     * per-agent delta when splits change between runs.
     *
     * Shape: { writingAgentId, periodStart, periodEnd, splits: [{ agentId, amount }] }
     */
    payoutContribution: jsonb("payout_contribution").$type<{
      writingAgentId: string;
      periodStart: string;
      periodEnd: string;
      splits: { agentId: string; amount: number }[];
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("commission_line_items_statement_idx").on(t.statementId),
    index("commission_line_items_writing_agent_idx").on(
      t.orgId,
      t.writingAgentId,
    ),
    // Covers the per-agent commission report (GET /agents/:id/commissions):
    // equality on org_id + writing_agent_id, range on period_start.
    // Equality columns lead, range column last. See migration
    // 0016_scale_indexes.sql.
    index("commission_line_items_org_agent_period_idx").on(
      t.orgId,
      t.writingAgentId,
      t.periodStart,
    ),
  ],
);

export const insertCommissionLineItemSchema = createInsertSchema(
  commissionLineItemsTable,
).omit({ createdAt: true });
export type InsertCommissionLineItem = z.infer<
  typeof insertCommissionLineItemSchema
>;
export type CommissionLineItem = typeof commissionLineItemsTable.$inferSelect;

/**
 * Per-agent payouts (computed from line items × hierarchies).
 */
export const agentCommissionPayoutsTable = pgTable(
  "agent_commission_payouts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    earned: numeric("earned", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    paid: numeric("paid", { precision: 12, scale: 2 }).notNull().default("0"),
    status: text("status").notNull().default("open"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidByUserId: text("paid_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("agent_commission_payouts_unique").on(
      t.orgId,
      t.agentId,
      t.periodStart,
      t.periodEnd,
    ),
  ],
);

export const insertAgentCommissionPayoutSchema = createInsertSchema(
  agentCommissionPayoutsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertAgentCommissionPayout = z.infer<
  typeof insertAgentCommissionPayoutSchema
>;
export type AgentCommissionPayout =
  typeof agentCommissionPayoutsTable.$inferSelect;

/**
 * Expected-vs-actual gaps.
 */
export const missedPaymentAlertsTable = pgTable(
  "missed_payment_alerts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contactsTable.id, { onDelete: "cascade" }),
    policyNumber: text("policy_number"),
    expectedAmount: numeric("expected_amount", { precision: 10, scale: 2 }),
    expectedPeriod: date("expected_period"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    uniqueIndex("missed_payment_alerts_unique").on(
      t.orgId,
      t.contactId,
      t.policyNumber,
      t.expectedPeriod,
    ),
  ],
);

export type MissedPaymentAlert = typeof missedPaymentAlertsTable.$inferSelect;
