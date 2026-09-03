/**
 * Enrollments — the operational record of a beneficiary's coverage.
 *
 * Before this table, coverage was flattened onto three `contacts` columns
 * (`currentPlanType`, `currentCarrierId`, `planYear`), so only the latest plan
 * existed. That shape cannot represent the things a Medicare agency actually
 * does:
 *
 *   - recording an enrollment, which is the core act of the job
 *   - AEP/OEP switching history (who moved, from what, to what, when)
 *   - a beneficiary holding an MA plan *and* a standalone PDP at once
 *   - year-over-year retention, and what a commission statement is paying for
 *
 * The commission engine in particular reconciles carrier statements against
 * expected commissions. Reconciling against a single mutable `contacts` row
 * means last year's payment is checked against this year's plan. This table is
 * what makes that arithmetic mean something.
 *
 * Migration posture: `contacts.currentPlanType` / `currentCarrierId` /
 * `planYear` are deliberately NOT dropped yet. 0037 backfills one enrollment
 * per covered contact and readers move here; the old columns stay for one
 * release so a rollback does not lose data. Dropping them is a follow-up.
 */
import {
  pgTable,
  text,
  integer,
  boolean,
  date,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { organizationsTable } from "./core";
import { agentsTable, carriersTable } from "./agents";
import { contactsTable, planTypeEnum } from "./crm";

/**
 * Lifecycle of a single enrollment.
 *
 *  - `pending`    — application submitted, carrier has not confirmed
 *  - `active`     — effectuated and in force
 *  - `terminated` — ended after taking effect (disenrollment, death, move)
 *  - `cancelled`  — never took effect (withdrawn, rapid disenrollment pre-effect)
 *  - `declined`   — carrier rejected the application
 *
 * `cancelled` and `terminated` are kept distinct because they have different
 * commission consequences: a cancellation is usually a full chargeback, a
 * termination is usually prorated.
 */
export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "pending",
  "active",
  "terminated",
  "cancelled",
  "declined",
]);

export const enrollmentsTable = pgTable(
  "enrollments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id")
      .notNull()
      .references(() => contactsTable.id, { onDelete: "cascade" }),
    carrierId: text("carrier_id").references(() => carriersTable.id),
    /** Writing agent. `set null` so removing an agent never destroys the record. */
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    /**
     * Carrier's plan identifier (CMS contract-plan-segment, e.g. "H1234-001-0").
     * Free text: there is no plans table yet, and carriers disagree on format.
     */
    planId: text("plan_id"),
    planName: text("plan_name"),
    /**
     * Reuses `plan_type` from `contacts` rather than defining a parallel
     * vocabulary — the 0037 backfill copies `contacts.current_plan_type`
     * straight across, and the commission-schedule lookup matches on this
     * value, so a second enum would silently break both.
     */
    planType: planTypeEnum("plan_type").notNull(),
    /** Plan year the coverage belongs to (e.g. 2026), not the signature year. */
    planYear: integer("plan_year").notNull(),
    /** Member/policy number assigned by the carrier once accepted. */
    policyNumber: text("policy_number"),
    applicationDate: date("application_date"),
    effectiveDate: date("effective_date").notNull(),
    /**
     * True once the carrier confirms the member is actually on the plan.
     * Commissions are only genuinely earned on effectuated enrollments, so
     * reconciliation filters on this rather than on `status` alone.
     */
    effectuated: boolean("effectuated").notNull().default(false),
    disenrolledDate: date("disenrolled_date"),
    status: enrollmentStatusEnum("status").notNull().default("pending"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("enrollments_org_contact_idx").on(t.orgId, t.contactId),
    index("enrollments_org_plan_year_idx").on(t.orgId, t.planYear),
    index("enrollments_org_effective_idx").on(t.orgId, t.effectiveDate),
    // Drives the commission-schedule lookup: carrier + plan type + year.
    index("enrollments_org_carrier_plan_idx").on(
      t.orgId,
      t.carrierId,
      t.planType,
      t.planYear,
    ),
    /**
     * A beneficiary can hold an MA plan and a standalone PDP in the same year,
     * but not two enrollments in the same plan type, same year, with the same
     * carrier. This is the constraint that stops double-counting a commission.
     */
    uniqueIndex("enrollments_contact_year_type_carrier_key").on(
      t.contactId,
      t.planYear,
      t.planType,
      t.carrierId,
    ),
  ],
);

export const insertEnrollmentSchema = createInsertSchema(enrollmentsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertEnrollment = z.infer<typeof insertEnrollmentSchema>;
export type Enrollment = typeof enrollmentsTable.$inferSelect;
