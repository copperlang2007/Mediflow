/**
 * Native browser calling (Twilio Voice).
 *
 * A `call_sessions` row is created by the API BEFORE the browser is allowed to
 * dial. The browser never supplies a phone number: the number lives here
 * (`to_number`, derived server-side from the contact) and the Twilio Voice
 * webhook dials only that stored value. A row is single-use: the webhook moves
 * it out of `initiated` atomically, so a replayed or forged session id cannot
 * place a second call.
 *
 * Calls refused by preclearance are stored too, with `status = 'blocked'`,
 * `blocked_reason` and the per-check `preclearance_result`, as an audit trail.
 *
 * No MBI, transcript or recording is stored here. Phone numbers are PHI-adjacent
 * and never written to logs or the audit log.
 */
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable, usersTable } from "./core";
import { contactsTable } from "./crm";
import { agentsTable } from "./agents";

export const CALL_SESSION_STATUSES = [
  "initiated",
  "ringing",
  "in_progress",
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
  "blocked",
] as const;
export type CallSessionStatus = (typeof CALL_SESSION_STATUSES)[number];

export const callSessionsTable = pgTable(
  "call_sessions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id").references(() => contactsTable.id, {
      onDelete: "set null",
    }),
    /** The agent profile whose licensing was checked, when there is one. */
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    /** The signed-in user who placed the call. */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    direction: text("direction").notNull().default("outbound"),
    toNumber: text("to_number").notNull(),
    fromNumber: text("from_number"),
    status: text("status").notNull().default("initiated"),
    twilioCallSid: text("twilio_call_sid"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    dispositionCode: text("disposition_code"),
    notes: text("notes"),
    /** Which preclearance checks passed / failed for this attempt. */
    preclearanceResult: jsonb("preclearance_result"),
    blockedReason: text("blocked_reason"),
    /** Recording stays OFF unless this is true. Nothing in the app sets it yet. */
    recordingEnabled: boolean("recording_enabled").notNull().default(false),
    /** The `call_log` activity written when the call completed (exactly once). */
    activityId: text("activity_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("call_sessions_org_id_created_at_idx").on(t.orgId, t.createdAt),
    uniqueIndex("call_sessions_twilio_call_sid_key").on(t.twilioCallSid),
    index("call_sessions_contact_id_idx").on(t.contactId),
  ],
);

export type CallSession = typeof callSessionsTable.$inferSelect;
export type NewCallSession = typeof callSessionsTable.$inferInsert;
