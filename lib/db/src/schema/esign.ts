/**
 * Native e-signature (Beta) — schema for envelopes + the granular audit
 * trail that justifies each signature.
 *
 * Replaces the originally-planned Dropbox Sign / DocuSign integration with
 * a Mediflow-owned signing flow. Beta scope (no PKI, no KBA, no LTV
 * timestamps); see the matching SQL migration 0020 and the provider in
 * artifacts/api-server/src/lib/esign/mediflowProvider.ts for the runtime
 * narrative.
 *
 * Two tables:
 *   - esign_envelopes        — durable record of a single signing flow
 *   - esign_signing_events   — granular audit trail (one row per event)
 *
 * Both are org-scoped. The envelopes table is partial-unique on
 * `(org_id, carrier_contracting_request_id)` while NOT voided so admins
 * can void + retry without violating the constraint.
 */
import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { documentsTable } from "./documents";
import { carrierContractingRequestsTable } from "./onboarding";

// ---- esign_envelopes -------------------------------------------------------

/**
 * Per-signer record persisted on the envelope. `signedAt` is populated
 * when the signer completes; the field is optional on insert so the
 * envelope can be created with just userId/displayName/email.
 */
export interface EnvelopeSigner {
  userId: string;
  displayName: string;
  email: string;
  signedAt?: string;
}

/**
 * Plain-language consent record captured at sign time. Versioned so we
 * can prove what the signer agreed to even if the consent text changes
 * later. `version` starts at "1.0.0" for the v1 native flow.
 */
export interface EsignConsentRecord {
  consentText: string;
  version: string;
  acceptedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export const esignEnvelopesTable = pgTable(
  "esign_envelopes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    carrierContractingRequestId: text("carrier_contracting_request_id")
      .notNull()
      .references(() => carrierContractingRequestsTable.id, {
        onDelete: "cascade",
      }),
    unsignedPdfDocumentId: text("unsigned_pdf_document_id")
      .notNull()
      .references(() => documentsTable.id),
    signedPdfDocumentId: text("signed_pdf_document_id").references(
      () => documentsTable.id,
    ),
    // jsonb<EnvelopeSigner[]>; drizzle's $type<> casts the inferred type
    // for both reads and writes so call sites get autocomplete on the
    // signer list without a runtime parse step.
    signers: jsonb("signers").$type<EnvelopeSigner[]>().notNull(),
    // String-enum (`pending` | `signed` | `completed` | `voided`). Kept as
    // text + an app-side validator so adding a new state is one PR rather
    // than a follow-up migration.
    status: text("status").notNull().default("pending"),
    // SHA-256 hex of the final signed PDF bytes. Tamper detection — the
    // tests verify the stored hash matches a fresh hash of the document
    // we read back from storage.
    integritySha256: text("integrity_sha256"),
    consentRecord: jsonb("consent_record").$type<EsignConsentRecord>(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One active envelope per (org, carrier_contracting_request). A voided
    // envelope frees the slot so a retry is permitted.
    uniqueIndex("esign_envelopes_active_per_request_unique")
      .on(t.orgId, t.carrierContractingRequestId)
      .where(sql`status != 'voided'`),
    index("esign_envelopes_org_status_idx").on(t.orgId, t.status),
  ],
);

export type EsignEnvelope = typeof esignEnvelopesTable.$inferSelect;
export const insertEsignEnvelopeSchema = createInsertSchema(
  esignEnvelopesTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertEsignEnvelope = z.infer<typeof insertEsignEnvelopeSchema>;

// ---- esign_signing_events --------------------------------------------------

/**
 * Allowed event types. Stored as text + app-side validator (same pattern as
 * `status` on envelopes) so a new event type can be introduced without a
 * migration.
 */
export const ESIGN_EVENT_TYPES = [
  "envelope_created",
  "document_viewed",
  "consent_accepted",
  "signature_captured",
  "envelope_completed",
  "envelope_voided",
] as const;
export type EsignEventType = (typeof ESIGN_EVENT_TYPES)[number];

export const esignSigningEventsTable = pgTable(
  "esign_signing_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    envelopeId: text("envelope_id")
      .notNull()
      .references(() => esignEnvelopesTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: text("actor_user_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    eventData: jsonb("event_data").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("esign_signing_events_envelope_time_idx").on(
      t.envelopeId,
      t.occurredAt,
    ),
    index("esign_signing_events_org_idx").on(t.orgId),
  ],
);

export type EsignSigningEvent = typeof esignSigningEventsTable.$inferSelect;
export const insertEsignSigningEventSchema = createInsertSchema(
  esignSigningEventsTable,
).omit({ occurredAt: true });
export type InsertEsignSigningEvent = z.infer<
  typeof insertEsignSigningEventSchema
>;
