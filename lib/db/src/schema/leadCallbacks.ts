/**
 * Callback SLA queue — captures inbound leads that were dropped because no
 * ready-to-sell agent was available, so they are tracked instead of lost.
 *
 * When `resolveAndRouteInbound` ends in `no_agent_available` (even the
 * eligible-offline overflow fallback found nobody), the lead used to just be
 * dropped — the only trace was a `lead_routing` row marked
 * `no_agent_available`. That defeats speed-to-lead: the prospect called in and
 * nobody followed up.
 *
 * A `lead_callbacks` row turns that miss into an SLA-tracked work item:
 *
 *   - **Capture** — one `open` row per dropped inbound, carrying enough context
 *     (carrier × state, contact, cert year) to re-route it later.
 *   - **SLA** — `slaDueAt = createdAt + LEAD_QUEUE_CALLBACK_SLA_MINUTES`. The
 *     admin Callbacks view counts down to it (red when overdue).
 *   - **Auto-resolve** — a scheduled sweep re-checks routability; once a
 *     ready-to-sell AND available agent exists for the pair it flips the row to
 *     `resolved` (recording which agent it would route to). If the SLA passes
 *     with still nobody, it flips to `expired`.
 *
 * Auto-DIALING the resolved callback is intentionally NOT done here — that
 * needs dial-ticket issuance + calling-hours/preclearance decisions. This table
 * tracks + resolves the queue; issuing the outbound call is a follow-up.
 */
import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable } from "./agents";

export const leadCallbacksTable = pgTable(
  "lead_callbacks",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    // External/MediFlow contact id. Null when the inbound was routed by raw
    // `contactState` without a contact record.
    contactId: text("contact_id"),
    carrierId: text("carrier_id").notNull(),
    stateCode: text("state_code").notNull(),
    certificationYear: integer("certification_year"),
    // 'open' | 'resolved' | 'expired' | 'cancelled'.
    status: text("status").notNull().default("open"),
    // When the callback must be actioned by. Set at insert from the SLA window.
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),
    // How many sweep re-check passes have touched this row.
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The ready-to-sell+available agent the sweep would route to on resolve.
    // SET NULL on agent delete so the historical record survives.
    resolvedAgentId: text("resolved_agent_id").references(
      () => agentsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Serves BOTH the admin worked-list (org's open callbacks, SLA-soonest
    // first) AND the worker scan (open rows past/approaching their SLA).
    index("lead_callbacks_org_status_sla_idx").on(
      t.orgId,
      t.status,
      t.slaDueAt,
    ),
  ],
);

export const insertLeadCallbackSchema = createInsertSchema(leadCallbacksTable);
export type InsertLeadCallback = z.infer<typeof insertLeadCallbackSchema>;
export type LeadCallback = typeof leadCallbacksTable.$inferSelect;
