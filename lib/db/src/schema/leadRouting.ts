/**
 * Lead routing claims — the audit + concurrency record for every inbound-lead
 * routing decision (see artifacts/api-server/src/lib/leadQueue/service.ts).
 *
 * The ready-to-sell queue used to be purely read-only: it ranked the eligible
 * pool and returned the lightest-loaded agent, but never recorded the choice.
 * That defeated load-balancing under bursts (back-to-back inbounds all read the
 * same loads and picked the same agent), left no compliance trail proving a
 * call went to a licensed/certified agent, and made retried webhooks route the
 * same contact to two different agents.
 *
 * Writing a row here at decision time fixes all three:
 *
 *   - **Audit** — one row per decision (who was routed where, for which
 *     carrier × state, how big the candidate pool was, which channel asked).
 *   - **Load balancing** — recent `routed` rows count as in-flight load
 *     alongside open leads, so the next inbound sees the agent it just routed
 *     to as busier and spreads to the next-lightest.
 *   - **Idempotency** — a retried route for the same `(orgId, contactId)`
 *     inside a short window returns the original decision instead of routing
 *     again.
 *
 * `no_agent_available` decisions are recorded too — they are the signal an
 * org's ready-to-sell pool was empty for a given carrier × state at a moment
 * in time, which is exactly what staffing/coverage analysis needs.
 */
import { pgTable, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable } from "./agents";

export const leadRoutingTable = pgTable(
  "lead_routing",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    // External contact identifier (GHL contactId / MediFlow contact id). Null
    // when the caller routed by raw `contactState` without a contact.
    contactId: text("contact_id"),
    carrierId: text("carrier_id").notNull(),
    stateCode: text("state_code").notNull(),
    certificationYear: integer("certification_year"),
    // Chosen agent — null when status = 'no_agent_available'. SET NULL on agent
    // delete so the historical decision survives without a dangling FK.
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    // 'routed' | 'no_agent_available'.
    status: text("status").notNull(),
    // Size of the eligible (and available, if presence-filtered) pool.
    candidatePool: integer("candidate_pool").notNull().default(0),
    // 'in_app' (Clerk route) | 'public' (HMAC/GHL route).
    source: text("source"),
    // Whether a live-presence filter was applied when this decision was made.
    presenceFiltered: boolean("presence_filtered").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // In-flight load: recent `routed` claims for an agent in an org.
    index("lead_routing_org_agent_created_idx").on(
      t.orgId,
      t.agentId,
      t.createdAt,
    ),
    // Idempotency lookup: the most recent decision for a contact in an org.
    index("lead_routing_org_contact_created_idx").on(
      t.orgId,
      t.contactId,
      t.createdAt,
    ),
  ],
);

export const insertLeadRoutingSchema = createInsertSchema(leadRoutingTable);
export type InsertLeadRouting = z.infer<typeof insertLeadRoutingSchema>;
export type LeadRouting = typeof leadRoutingTable.$inferSelect;
