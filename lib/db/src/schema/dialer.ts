/**
 * masterBRIDGE dialer integration (Option A, Phase 2).
 *
 * MediFlow is the system of record; the dialer is a stateless execution
 * service. These tables exist only to support the API/event boundary:
 *
 *  - `dialTicketsTable` — every dial request MediFlow issues. The
 *    `dialTicketId` (UUID) is the correlation key across both systems
 *    (spec §3). It also carries the transcript-purge-confirmation state
 *    (§6.1). NB: the MBI is NEVER stored here — it never crosses the
 *    boundary (§3.1).
 *  - `dialerEventsTable` — inbound webhook ledger. Primary key is the
 *    dialer's `eventId` so duplicate / retried deliveries dedupe at the
 *    database level (§6.2: idempotent on eventId, tolerate out-of-order).
 */
import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";

export const dialTicketsTable = pgTable(
  "dial_tickets",
  {
    // UUID minted by MediFlow — the cross-system correlation key.
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    agentId: text("agent_id"),
    // Opaque MediFlow contact reference — never a foreign key into the
    // dialer's world, and never the MBI.
    contactRef: text("contact_ref"),
    campaignId: text("campaign_id"),
    // QUEUED | ISSUED | REVOKED | FAILED — lifecycle of the ticket itself.
    status: text("status").notNull().default("QUEUED"),
    // Auditable preclearance decision id (references an audit row).
    preclearanceId: text("preclearance_id"),
    // Dialer's returned id for the underlying call (filled on call.* events).
    dialerCallId: text("dialer_call_id"),
    // Transcript purge bookkeeping (§6.1).
    transcriptHash: text("transcript_hash"),
    transcriptReadyAt: timestamp("transcript_ready_at", { withTimezone: true }),
    transcriptPurgeConfirmedAt: timestamp("transcript_purge_confirmed_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("dial_tickets_org_id_idx").on(t.orgId),
    index("dial_tickets_org_id_status_idx").on(t.orgId, t.status),
  ],
);

export const insertDialTicketSchema = createInsertSchema(dialTicketsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertDialTicket = z.infer<typeof insertDialTicketSchema>;
export type DialTicket = typeof dialTicketsTable.$inferSelect;

export const dialerEventsTable = pgTable(
  "dialer_events",
  {
    // The dialer's eventId — PK so a duplicate delivery is a no-op insert.
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    type: text("type").notNull(),
    dialTicketId: text("dial_ticket_id"),
    dialerCallId: text("dialer_call_id"),
    schemaVersion: text("schema_version"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Full event envelope, retained for the immutable audit trail.
    payload: jsonb("payload"),
  },
  (t) => [
    index("dialer_events_org_id_received_at_idx").on(t.orgId, t.receivedAt),
    index("dialer_events_dial_ticket_id_idx").on(t.dialTicketId),
  ],
);

export type DialerEvent = typeof dialerEventsTable.$inferSelect;
