/**
 * Agent onboarding + carrier-contracting schema.
 *
 * Three tables, all org-scoped:
 *   - agent_onboarding_runs        — one in-flight onboarding per agent
 *   - agent_contracting_profiles   — encrypted PII vault for paperwork data
 *   - carrier_contracting_requests — one per (onboarding × carrier)
 *
 * These tables back the contracting workflow that ships v1 for the
 * INSUREitALL design partner. The actual carrier paperwork PDFs, Dropbox
 * Sign envelope IDs, and appointment-desk email-out paths are wired up in
 * later phases; the columns are present here so the migration is stable.
 */
import {
  pgTable,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  customType,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { agentsTable, carriersTable } from "./agents";
import { documentsTable } from "./documents";

// drizzle-orm has no first-class bytea column, but PII ciphertext + HMAC
// blind index are both binary. Custom type returns Uint8Array/Buffer on
// read (PGlite vs node-postgres differ — call sites coerce as needed) and
// accepts a Buffer on write.
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

// text[] column — agent contracts in this set of state codes for a carrier.
const textArray = customType<{ data: string[]; notNull: true; default: false }>(
  {
    dataType() {
      return "text[]";
    },
  },
);

// ---- agent_onboarding_runs --------------------------------------------------

export const agentOnboardingRunsTable = pgTable(
  "agent_onboarding_runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    // Admin (or compliance manager) who fired POST /onboarding/start. We
    // route the "Review and request contracting" admin task back to this
    // user once the agent finishes selecting carriers, so they can flip
    // the run into `signing` themselves. NULL is permitted for legacy /
    // imported runs but every new row populates it.
    startedByUserId: text("started_by_user_id"),
    // String-enum (not pgEnum) so we can add new states via app-side
    // validation without a follow-up migration on every workflow tweak. Each
    // route validates against the allowlist via the state machine helper.
    status: text("status").notNull().default("draft"),
    // Phase 1.5 POA pivot. Default `not_applicable` keeps legacy/in-flight
    // runs working — they don't have a POA decision until the wizard surfaces
    // the new step. Allowed values (enforced by the state machine, not the
    // DB): not_applicable | pending | signed | opted_out.
    poaStatus: text("poa_status").notNull().default("not_applicable"),
    // FK to esign_envelopes — set when the POA envelope is created. Soft FK
    // (no `references()` here) because the envelope row is created AFTER
    // this row exists and the inverse edge already lives on esign_envelopes.
    poaEnvelopeId: text("poa_envelope_id"),
    // 90 days after signing by default (POA_DAYS_TO_EXPIRE env var
    // overrides). When the run completes carrier submissions before expiry,
    // INSUREitALL renews / re-collects as needed (out of scope here).
    poaExpiresAt: timestamp("poa_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedSteps: jsonb("completed_steps").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One active onboarding per agent. Cancelled runs don't count against
    // the index, so a fresh "retry" onboarding can be started after cancel.
    uniqueIndex("agent_onboarding_runs_active_per_agent_unique")
      .on(t.orgId, t.agentId)
      .where(sql`status != 'cancelled'`),
    index("agent_onboarding_runs_org_status_idx").on(t.orgId, t.status),
  ],
);

export type AgentOnboardingRun = typeof agentOnboardingRunsTable.$inferSelect;
export const insertAgentOnboardingRunSchema = createInsertSchema(
  agentOnboardingRunsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertAgentOnboardingRun = z.infer<
  typeof insertAgentOnboardingRunSchema
>;

// ---- agent_contracting_profiles --------------------------------------------

export const agentContractingProfilesTable = pgTable(
  "agent_contracting_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    // SSN: encrypted + HMAC blind index. Same shape as contacts.medicare_id_*.
    ssnEncrypted: bytea("ssn_encrypted"),
    ssnHash: bytea("ssn_hash"),
    dob: date("dob"),
    homeAddressLine1: text("home_address_line1"),
    homeAddressLine2: text("home_address_line2"),
    homeCity: text("home_city"),
    homeState: text("home_state"),
    homeZip: text("home_zip"),
    mailingSameAsHome: boolean("mailing_same_as_home").notNull().default(true),
    mailingAddressLine1: text("mailing_address_line1"),
    mailingAddressLine2: text("mailing_address_line2"),
    mailingCity: text("mailing_city"),
    mailingState: text("mailing_state"),
    mailingZip: text("mailing_zip"),
    phone: text("phone"),
    email: text("email"),
    // Business entity for paperwork (1099 routing). `individual` is the common
    // case; LLC/corp/partnership exist on the form.
    entityType: text("entity_type"),
    businessName: text("business_name"),
    // EIN (employer identifier) is PII — encrypted, same shape as SSN.
    businessEinEncrypted: bytea("business_ein_encrypted"),
    eAndOCarrier: text("e_and_o_carrier"),
    eAndOPolicyNumber: text("e_and_o_policy_number"),
    eAndOExpiresOn: date("e_and_o_expires_on"),
    // Vendor-agnostic background-check state; integration ships later.
    backgroundCheckStatus: text("background_check_status")
      .notNull()
      .default("not_started"),
    backgroundCheckAuthorizedAt: timestamp("background_check_authorized_at", {
      withTimezone: true,
    }),
    backgroundCheckClearedAt: timestamp("background_check_cleared_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("agent_contracting_profiles_org_idx").on(t.orgId),
    // Blind-index lookup for dup detection across agents — same partial-index
    // pattern as `contacts.medicare_id_hash_idx`.
    index("agent_contracting_profiles_ssn_hash_idx")
      .on(t.ssnHash)
      .where(sql`ssn_hash IS NOT NULL`),
  ],
);

export type AgentContractingProfile =
  typeof agentContractingProfilesTable.$inferSelect;
export const insertAgentContractingProfileSchema = createInsertSchema(
  agentContractingProfilesTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertAgentContractingProfile = z.infer<
  typeof insertAgentContractingProfileSchema
>;

// ---- carrier_contracting_requests ------------------------------------------

export const carrierContractingRequestsTable = pgTable(
  "carrier_contracting_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    onboardingRunId: text("onboarding_run_id")
      .notNull()
      .references(() => agentOnboardingRunsTable.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriersTable.id),
    states: textArray("states").notNull(),
    status: text("status").notNull().default("draft"),
    paperworkDocumentId: text("paperwork_document_id").references(
      () => documentsTable.id,
      { onDelete: "set null" },
    ),
    // Dropbox Sign envelope id — populated when we hand the signed packet off
    // to the e-signature provider (Day 5). NULL while we're in the draft /
    // paperwork-generated states.
    signatureEnvelopeId: text("signature_envelope_id"),
    signatureCompletedAt: timestamp("signature_completed_at", {
      withTimezone: true,
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    appointedAt: timestamp("appointed_at", { withTimezone: true }),
    writingNumber: text("writing_number"),
    carrierResponseData: jsonb("carrier_response_data").notNull().default({}),
    notes: text("notes").notNull().default(""),
    // Drives admin-dashboard "stuck request" alerts (Days 3+).
    lastStatusChangeAt: timestamp("last_status_change_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One active request per (agent, carrier). The state list can be amended
    // on the same row — opening multiple parallel requests for the same
    // carrier with overlapping states would race the carrier's appointment
    // desk and confuse downstream commission attribution.
    uniqueIndex("carrier_contracting_requests_active_per_carrier_unique")
      .on(t.orgId, t.agentId, t.carrierId)
      .where(sql`status != 'cancelled'`),
    index("carrier_contracting_requests_run_idx").on(t.onboardingRunId),
    index("carrier_contracting_requests_org_status_idx").on(t.orgId, t.status),
  ],
);

export type CarrierContractingRequest =
  typeof carrierContractingRequestsTable.$inferSelect;
export const insertCarrierContractingRequestSchema = createInsertSchema(
  carrierContractingRequestsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertCarrierContractingRequest = z.infer<
  typeof insertCarrierContractingRequestSchema
>;
