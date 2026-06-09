/**
 * Beneficiary complaint tracking (CTM — Complaint Tracking Module).
 *
 * CMS requires Medicare Advantage / Part D agencies to log, investigate, and
 * resolve beneficiary complaints within defined turnaround windows, and to be
 * able to produce that record on audit. A complaint can originate from CMS's
 * own Complaint Tracking Module (a "CTM case" routed to the plan/agency), from
 * the beneficiary directly, from a carrier, or be raised internally (e.g. by a
 * compliance reviewer off the back of a flagged call).
 *
 * Each `complaints` row is the agency's system-of-record entry for one
 * complaint:
 *
 *   - **Triage** — `category` + `severity` classify it; `severity` drives the
 *     resolution SLA (`dueAt`), so the worked-list can count down and surface
 *     overdue items in red.
 *   - **Workflow** — `status` moves open → investigating → resolved → closed.
 *     `assignedToUserId` owns it; `resolutionNotes` + `resolvedAt` capture the
 *     outcome for the audit trail.
 *   - **Linkage** — optional `contactId` (the beneficiary) and `agentId` (the
 *     agent whose conduct is in question) tie the complaint back into the CRM.
 *     `ctmCaseId` holds the external CMS case number when one exists.
 *
 * PHI minimization: `subject` / `description` are a short, non-PHI summary of
 * the issue. The Medicare Beneficiary Identifier and other identifiers are
 * never stored here — the `contactId` link is the way back to that data.
 */
import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable, usersTable } from "./core";
import { contactsTable } from "./crm";
import { agentsTable } from "./agents";

/** Where the complaint came from. */
export const complaintSourceEnum = pgEnum("complaint_source", [
  "cms_ctm",
  "beneficiary_direct",
  "carrier",
  "internal",
  "other",
]);

/** What the complaint is about (CMS complaint categories, simplified). */
export const complaintCategoryEnum = pgEnum("complaint_category", [
  "marketing",
  "enrollment",
  "benefits",
  "access",
  "privacy",
  "agent_conduct",
  "billing",
  "other",
]);

/** Triage severity — drives the resolution SLA. */
export const complaintSeverityEnum = pgEnum("complaint_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

/** Workflow state. */
export const complaintStatusEnum = pgEnum("complaint_status", [
  "open",
  "investigating",
  "resolved",
  "closed",
]);

export const complaintsTable = pgTable(
  "complaints",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    // The beneficiary the complaint concerns. Null when not yet matched to a
    // CRM contact. SET NULL on contact delete so the complaint record survives.
    contactId: text("contact_id").references(() => contactsTable.id, {
      onDelete: "set null",
    }),
    // The agent whose conduct is in question, when applicable. SET NULL on
    // agent delete to preserve the historical complaint.
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    source: complaintSourceEnum("source").notNull().default("beneficiary_direct"),
    category: complaintCategoryEnum("category").notNull().default("other"),
    severity: complaintSeverityEnum("severity").notNull().default("medium"),
    status: complaintStatusEnum("status").notNull().default("open"),
    // Short, non-PHI summary. Never the MBI or other identifiers.
    subject: text("subject").notNull(),
    description: text("description"),
    // External CMS Complaint Tracking Module case number, when one exists.
    ctmCaseId: text("ctm_case_id"),
    // When the complaint was received (may predate the row's createdAt).
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Resolution SLA deadline, derived from severity at create time.
    dueAt: timestamp("due_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNotes: text("resolution_notes"),
    // User who owns the complaint. SET NULL on user delete.
    assignedToUserId: text("assigned_to_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    // User who logged it. SET NULL on user delete; "system" is stored as a
    // literal for complaints raised by an automated process.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Serves the worked-list: an org's complaints by status, SLA-soonest first.
    index("complaints_org_status_due_idx").on(t.orgId, t.status, t.dueAt),
    // Open a beneficiary's complaint history from the contact page.
    index("complaints_org_contact_idx").on(t.orgId, t.contactId),
  ],
);

export const insertComplaintSchema = createInsertSchema(complaintsTable);
export type InsertComplaint = z.infer<typeof insertComplaintSchema>;
export type Complaint = typeof complaintsTable.$inferSelect;
