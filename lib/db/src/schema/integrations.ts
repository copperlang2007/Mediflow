/**
 * Inbound third-party integrations (EnrollHere webhooks, GoHighLevel feed).
 */
import { pgTable, text, timestamp, integer, jsonb, index, unique, date, customType } from "drizzle-orm/pg-core";
import { organizationsTable } from "./core";
import { contactsTable, activitiesTable } from "./crm";
import { enrollmentsTable } from "./enrollments";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

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
    /**
     * Null once the contact is hard-deleted: the link stays as a tombstone so
     * the feed never recreates a person the agency deleted.
     */
    contactId: text("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
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
  /** GHL's paging tuple for the last contact written — resume strictly after it. */
  cursorSearchAfter: jsonb("cursor_search_after"),
  runningSince: timestamp("running_since", { withTimezone: true }),
  /** Fencing token of the run holding the lease; every state write matches on it. */
  leaseToken: text("lease_token"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  lastRunCreated: integer("last_run_created").notNull().default(0),
  lastRunUpdated: integer("last_run_updated").notNull().default(0),
  lastRunSkipped: integer("last_run_skipped").notNull().default(0),
  /** Contacts that failed to save (also counted in lastRunSkipped). */
  lastRunFailed: integer("last_run_failed").notNull().default(0),
  backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
  /** A pending "re-sync everything" request; the next run to start honours and clears it. */
  fullResyncRequestedAt: timestamp("full_resync_requested_at", { withTimezone: true }),
});

export type GhlSyncState = typeof ghlSyncStateTable.$inferSelect;

/**
 * A full enrollment application (EnrollHere / Sunfire), one per
 * (org, source, applicationKey). The key is the Sunfire confirmation code, or
 * the EnrollHere policy id when there is none.
 *
 * Only non-sensitive fields are promoted to plain columns (plan, carrier,
 * dates, status, agent). The complete payload lives only in
 * `enrollmentApplicationVersionsTable`, AES-GCM encrypted: it holds health
 * answers and possibly race/ethnicity, which must never feed routing,
 * scoring or AI. The Medicare and Medicaid numbers are encrypted columns.
 */
export const enrollmentApplicationsTable = pgTable(
  "enrollment_applications",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizationsTable.id),
    source: text("source").notNull(),
    applicationKey: text("application_key").notNull(),
    confirmationCode: text("confirmation_code"),
    externalPolicyId: text("external_policy_id"),
    /** Cascade: purging a contact purges their applications (PHI) with them. */
    contactId: text("contact_id").references(() => contactsTable.id, { onDelete: "cascade" }),
    enrollmentId: text("enrollment_id").references(() => enrollmentsTable.id, { onDelete: "set null" }),
    currentVersion: integer("current_version").notNull().default(1),
    lastEventType: text("last_event_type"),
    carrierName: text("carrier_name"),
    planId: text("plan_id"),
    planName: text("plan_name"),
    planType: text("plan_type"),
    snpType: text("snp_type"),
    policyStatus: text("policy_status"),
    effectiveDate: date("effective_date"),
    signatureDate: date("signature_date"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    agentEmail: text("agent_email"),
    agentNpn: text("agent_npn"),
    medicareIdEncrypted: bytea("medicare_id_encrypted"),
    medicareIdHash: bytea("medicare_id_hash"),
    medicaidNumberEncrypted: bytea("medicaid_number_encrypted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    unique("enrollment_applications_org_source_key").on(t.orgId, t.source, t.applicationKey),
    index("enrollment_applications_org_contact_idx").on(t.orgId, t.contactId),
  ],
);

/** Every distinct version of an application's payload, encrypted. */
export const enrollmentApplicationVersionsTable = pgTable(
  "enrollment_application_versions",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull().references(() => enrollmentApplicationsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    eventType: text("event_type"),
    payloadEncrypted: bytea("payload_encrypted").notNull(),
    /** HMAC of the canonical payload: identical redeliveries don't add a version. */
    payloadHmac: bytea("payload_hmac").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("enrollment_application_versions_app_version_key").on(t.applicationId, t.version),
    unique("enrollment_application_versions_app_hmac_key").on(t.applicationId, t.payloadHmac),
  ],
);

export type EnrollmentApplication = typeof enrollmentApplicationsTable.$inferSelect;
