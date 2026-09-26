/**
 * Inbound third-party integrations (EnrollHere webhooks, GoHighLevel feed).
 */
import { pgTable, text, timestamp, index, unique } from "drizzle-orm/pg-core";
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
