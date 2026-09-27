/**
 * Writes an EnrollHere policy event: the enrollment row and the full
 * application record (encrypted, versioned).
 *
 * Application record rules:
 *   - one record per (org, source, applicationKey); the key is the Sunfire
 *     confirmation code, or `policy:<EnrollHere policy id>` when there is none;
 *   - every distinct payload is kept as an encrypted version (AES-GCM, the
 *     same PHI key as contact data); an identical redelivery adds nothing;
 *   - only plan / carrier / dates / status / agent are plain columns; the
 *     Medicare and Medicaid numbers are encrypted columns; health answers and
 *     race/ethnicity exist only inside the encrypted payload.
 */
import { randomUUID } from "crypto";
import { and, eq, max, sql } from "drizzle-orm";
import {
  enrollmentsTable,
  enrollmentApplicationsTable,
  enrollmentApplicationVersionsTable,
  encryptMedicareId,
  encryptPii,
} from "@workspace/db";
import { canonicalJson } from "../payload";
import { resolveCarrier, type Tx } from "../../contactImport";
import { syncContactCoverageProjection } from "../../../routes/enrollments";
import { mapPolicyStatus, type ParsedPolicyEvent } from "./policyEvent";

export const APPLICATION_SOURCE = "enrollhere";

/**
 * Upsert the enrollment described by the policy. Keyed like every other
 * writer on (contact, plan year, plan type, carrier), so a policy update lands
 * on the same row. Returns null when the policy lacks a plan type or
 * effective date (the application is still stored).
 */
export async function upsertPolicyEnrollment(
  tx: Tx,
  orgId: string,
  contactId: string,
  agentId: string | null,
  p: ParsedPolicyEvent,
): Promise<string | null> {
  if (!p.planType || !p.effectiveDate) return null;
  const carrierId = p.carrierName ? await resolveCarrier(tx, orgId, p.carrierName, new Map(), []) : null;
  const { status, effectuated } = mapPolicyStatus(p.policyStatus);
  const planYear = Number(p.effectiveDate.slice(0, 4));
  const [row] = await tx.insert(enrollmentsTable).values({
    id: randomUUID(),
    orgId,
    contactId,
    carrierId,
    agentId,
    planId: p.planId,
    planName: p.planName,
    planType: p.planType,
    planYear,
    policyNumber: p.policyNumber,
    applicationDate: p.signatureDate,
    effectiveDate: p.effectiveDate,
    effectuated,
    status,
    notes: "From EnrollHere",
  }).onConflictDoUpdate({
    target: [enrollmentsTable.contactId, enrollmentsTable.planYear, enrollmentsTable.planType, enrollmentsTable.carrierId],
    // EnrollHere is the source of truth for status on its own policies; plan
    // details only fill blanks so a manual correction isn't overwritten.
    set: {
      status,
      effectuated,
      planId: sql`coalesce(${enrollmentsTable.planId}, excluded.plan_id)`,
      planName: sql`coalesce(${enrollmentsTable.planName}, excluded.plan_name)`,
      policyNumber: sql`coalesce(${enrollmentsTable.policyNumber}, excluded.policy_number)`,
      applicationDate: sql`coalesce(${enrollmentsTable.applicationDate}, excluded.application_date)`,
      agentId: sql`coalesce(${enrollmentsTable.agentId}, excluded.agent_id)`,
    },
  }).returning({ id: enrollmentsTable.id });
  await syncContactCoverageProjection(contactId, orgId, tx);
  return row?.id ?? null;
}

export interface StoredApplication {
  applicationId: string;
  version: number;
  /** False when this exact payload was already stored (a redelivery). */
  newVersion: boolean;
}

export async function storeApplication(
  tx: Tx,
  orgId: string,
  p: ParsedPolicyEvent,
  links: { contactId: string | null; enrollmentId: string | null },
): Promise<StoredApplication | null> {
  const applicationKey = p.confirmationCode ?? (p.policyId ? `policy:${p.policyId}` : null);
  if (!applicationKey) return null;

  // Serialize writers for one application so two deliveries can't both take
  // version N+1.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment-app:${orgId}:${applicationKey}`}, 0))`);

  const mbi = p.medicareNumber ? encryptMedicareId(p.medicareNumber) : null;
  const medicaid = p.medicaidNumber ? encryptPii(p.medicaidNumber).encrypted : null;
  const promoted = {
    confirmationCode: p.confirmationCode,
    externalPolicyId: p.policyId,
    lastEventType: p.eventType,
    carrierName: p.carrierName,
    planId: p.planId,
    planName: p.planName,
    planType: p.planTypeRaw,
    snpType: p.snpType,
    policyStatus: p.policyStatus,
    effectiveDate: p.effectiveDate,
    signatureDate: p.signatureDate,
    submittedAt: p.submittedAt,
    agentEmail: p.agentEmail,
    agentNpn: p.agentNpn,
    // The latest payload is authoritative: an update without a number clears
    // it rather than leaving a stale one readable.
    medicareIdEncrypted: mbi?.encrypted ?? null,
    medicareIdHash: mbi?.hash ?? null,
    medicaidNumberEncrypted: medicaid,
  };

  const [app] = await tx.insert(enrollmentApplicationsTable).values({
    id: randomUUID(),
    orgId,
    source: APPLICATION_SOURCE,
    applicationKey,
    contactId: links.contactId,
    enrollmentId: links.enrollmentId,
    ...promoted,
  }).onConflictDoUpdate({
    target: [enrollmentApplicationsTable.orgId, enrollmentApplicationsTable.source, enrollmentApplicationsTable.applicationKey],
    set: {
      ...promoted,
      contactId: sql`coalesce(excluded.contact_id, ${enrollmentApplicationsTable.contactId})`,
      enrollmentId: sql`coalesce(excluded.enrollment_id, ${enrollmentApplicationsTable.enrollmentId})`,
    },
  }).returning({ id: enrollmentApplicationsTable.id, currentVersion: enrollmentApplicationsTable.currentVersion });

  const { encrypted, hash } = encryptPii(canonicalJson(p.storedPayload as never));
  const [existing] = await tx.select({ version: enrollmentApplicationVersionsTable.version })
    .from(enrollmentApplicationVersionsTable)
    .where(and(eq(enrollmentApplicationVersionsTable.applicationId, app!.id), eq(enrollmentApplicationVersionsTable.payloadHmac, hash)))
    .limit(1);
  if (existing) return { applicationId: app!.id, version: existing.version, newVersion: false };

  const [{ top } = { top: null }] = await tx.select({ top: max(enrollmentApplicationVersionsTable.version) })
    .from(enrollmentApplicationVersionsTable)
    .where(eq(enrollmentApplicationVersionsTable.applicationId, app!.id));
  const version = (top ?? 0) + 1;
  await tx.insert(enrollmentApplicationVersionsTable).values({
    id: randomUUID(),
    applicationId: app!.id,
    version,
    eventType: p.eventType,
    payloadEncrypted: encrypted,
    payloadHmac: hash,
  });
  await tx.update(enrollmentApplicationsTable).set({ currentVersion: version })
    .where(eq(enrollmentApplicationsTable.id, app!.id));
  return { applicationId: app!.id, version, newVersion: true };
}
