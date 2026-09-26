/**
 * Inbound third-party integrations (EnrollHere webhooks, GoHighLevel feed).
 */
import { pgTable, text, timestamp, integer, index, unique } from "drizzle-orm/pg-core";
import { organizationsTable } from "./core";
import { contactsTable, activitiesTable } from "./crm";

/**
 * One row per inbound webhook event, keyed by the sender's own event/call id.
 * The unique key makes a redelivered event a no-op, so a retrying sender can
 * never log the same call twice.
 *
 * The payload itself is NOT stored: it carries PHI (names, DOB, Medicare ID)
 * and the contact + activity rows already hold what we keep. `payloadKeys`
 * records only the field names seen, so an unmapped field in a vendor's
 * payload can be diagnosed without retaining the data.
 */
export const integrationEventsTable = pgTable(
  "integration_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    eventType: text("event_type"),
    contactId: text("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
    activityId: text("activity_id").references(() => activitiesTable.id, { onDelete: "set null" }),
    payloadKeys: text("payload_keys").array(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("integration_events_org_source_external_key").on(t.orgId, t.source, t.externalId),
    index("integration_events_org_received_idx").on(t.orgId, t.receivedAt),
  ],
);

export type IntegrationEvent = typeof integrationEventsTable.$inferSelect;

/**
 * Maps a contact in an external system (e.g. a GoHighLevel contact id) to our
 * contact, so a later update from that system lands on the same person even
 * after their email or phone changed.
 */
export const externalContactLinksTable = pgTable(
  "external_contact_links",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contactsTable.id, { onDelete: "cascade" }),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("external_contact_links_org_source_external_key").on(t.orgId, t.source, t.externalId),
    index("external_contact_links_contact_idx").on(t.contactId),
  ],
);

/**
 * Per-org GoHighLevel pull state. `cursorUpdatedAt` is the `dateUpdated` of
 * the last contact processed; the next run asks GHL for contacts updated at
 * or after it. `runningSince` is a lease so the scheduled pull and a manual
 * backfill never run the same org at once.
 */
export const ghlSyncStateTable = pgTable("ghl_sync_state", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizationsTable.id),
  locationId: text("location_id").notNull(),
  cursorUpdatedAt: timestamp("cursor_updated_at", { withTimezone: true }),
  runningSince: timestamp("running_since", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  lastRunCreated: integer("last_run_created").notNull().default(0),
  lastRunUpdated: integer("last_run_updated").notNull().default(0),
  lastRunSkipped: integer("last_run_skipped").notNull().default(0),
  backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
});

export type GhlSyncState = typeof ghlSyncStateTable.$inferSelect;
