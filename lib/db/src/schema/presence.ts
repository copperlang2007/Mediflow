/**
 * Agent presence — the real-time "available right now" signal that the
 * inbound lead queue intersects with ready-to-sell eligibility before routing
 * a call (see artifacts/api-server/src/lib/leadQueue + docs/inbound-lead-queue.md).
 *
 * One row per agent. Two writers keep it current:
 *
 *   - **Heartbeat** (the web app): the agent explicitly goes Available/Away
 *     and the client re-pings on an interval. Only a heartbeat sets
 *     `available` — it is the sole authoritative source of "ready for a new
 *     call". Each ping pushes `expires_at` forward.
 *   - **Dialer call-state events** (`lib/dialer/handlers.ts`): authoritative
 *     busy/free truth. `call.in_progress` ⇒ `on_call` (removed from the
 *     routable pool); `call.completed`/`failed` ⇒ `wrap`. The dialer never
 *     sets `available` — the agent returns to the pool only via their next
 *     heartbeat. This biases fail-CLOSED: a missed terminal event leaves the
 *     agent `on_call` (excluded) rather than wrongly routable.
 *
 * TTL is enforced at READ time: the queue only counts a row as available when
 * `status = 'available' AND expires_at > now()`. A stale row (dropped tab,
 * missed "offline") therefore stops being routable on its own — no background
 * sweep is required for correctness. `expires_at` NULL = never auto-expires
 * (not used by the heartbeat path, which always sets it).
 */
import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable } from "./agents";

export const agentPresenceStatusEnum = pgEnum("agent_presence_status", [
  "available",
  "on_call",
  "wrap",
  "away",
  "offline",
]);

export const agentPresenceTable = pgTable(
  "agent_presence",
  {
    // One row per agent — the agent id IS the primary key (upsert target).
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    status: agentPresenceStatusEnum("status").notNull().default("offline"),
    // `dialer` | `heartbeat` — which writer last touched the row (debugging).
    source: text("source"),
    // Last dialer event id applied, for traceability of busy/free flips.
    lastEventId: text("last_event_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // After this instant the row no longer counts as available (read-time TTL).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Hot path: "available agents in this org" — the queue's availability read.
    index("agent_presence_org_status_idx").on(t.orgId, t.status),
  ],
);

export const insertAgentPresenceSchema = createInsertSchema(
  agentPresenceTable,
).omit({ updatedAt: true });
export type InsertAgentPresence = z.infer<typeof insertAgentPresenceSchema>;
export type AgentPresence = typeof agentPresenceTable.$inferSelect;
