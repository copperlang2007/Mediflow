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
import { and, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
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
import { logger } from "../../logger";

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
  let carrierId = p.carrierName ? await resolveCarrier(tx, orgId, p.carrierName, new Map(), []) : null;
  const { status, effectuated } = mapPolicyStatus(p.policyStatus);
  const planYear = Number(p.effectiveDate.slice(0, 4));

  // The policy's own enrollment, found through its stored application: an
  // update lands there even when the carrier, plan type or plan year changed.
  const prior = await priorEnrollmentFor(tx, orgId, contactId, p.policyId);
  if (prior) {
    const target = { carrierId: carrierId ?? prior.carrierId, planYear, planType: p.planType };
    const [clash] = await tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable).where(and(
      eq(enrollmentsTable.contactId, contactId),
      eq(enrollmentsTable.planYear, target.planYear),
      eq(enrollmentsTable.planType, target.planType),
      target.carrierId ? eq(enrollmentsTable.carrierId, target.carrierId) : isNull(enrollmentsTable.carrierId),
      ne(enrollmentsTable.id, prior.id),
    )).limit(1);
    if (!clash) {
      await tx.update(enrollmentsTable).set({
        ...target,
        ...(p.policyStatus ? { status, effectuated } : {}),
        effectiveDate: p.effectiveDate,
        planId: sql`coalesce(${enrollmentsTable.planId}, ${p.planId})`,
        planName: sql`coalesce(${enrollmentsTable.planName}, ${p.planName})`,
        policyNumber: sql`coalesce(${enrollmentsTable.policyNumber}, ${p.policyNumber})`,
        applicationDate: sql`coalesce(${enrollmentsTable.applicationDate}, ${p.signatureDate}::date)`,
        agentId: sql`coalesce(${enrollmentsTable.agentId}, ${agentId})`,
      }).where(eq(enrollmentsTable.id, prior.id));
      await syncContactCoverageProjection(contactId, orgId, tx);
      return prior.id;
    }
  }

  // The carrier is part of the enrollment key, so a delivery that gains or
  // loses it would otherwise start a second row for the same policy.
  const sameSlot = and(
    eq(enrollmentsTable.orgId, orgId),
    eq(enrollmentsTable.contactId, contactId),
    eq(enrollmentsTable.planYear, planYear),
    eq(enrollmentsTable.planType, p.planType),
  );
  const existing = await tx.select({ id: enrollmentsTable.id, carrierId: enrollmentsTable.carrierId })
    .from(enrollmentsTable).where(sameSlot);
  if (!carrierId && existing.length === 1) {
    carrierId = existing[0]!.carrierId; // lands on the one row already there
  } else if (carrierId && !existing.some((e) => e.carrierId === carrierId)) {
    const carrierless = existing.find((e) => e.carrierId === null);
    if (carrierless) {
      await tx.update(enrollmentsTable).set({ carrierId }).where(eq(enrollmentsTable.id, carrierless.id));
    }
  }
  // This path only runs when the policy's own enrollment wasn't found above,
  // so an in-force row already in the slot belongs to something else: a
  // manual or CSV entry, or another policy (a plan switch within the same
  // carrier). A policy that is not in force never undoes that coverage.
  const [inForceElsewhere] = await tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable)
    .where(and(
      eq(enrollmentsTable.contactId, contactId),
      eq(enrollmentsTable.planYear, planYear),
      eq(enrollmentsTable.planType, p.planType),
      carrierId ? eq(enrollmentsTable.carrierId, carrierId) : isNull(enrollmentsTable.carrierId),
      eq(enrollmentsTable.effectuated, true),
    )).limit(1);
  // An update that carries no status at all leaves the status alone.
  const keepStatus = !p.policyStatus || (!!inForceElsewhere && !effectuated);

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
      status: keepStatus ? sql`${enrollmentsTable.status}` : status,
      effectuated: keepStatus ? sql`${enrollmentsTable.effectuated}` : effectuated,
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

/**
 * The enrollment an earlier delivery of this policy created, if it's still this
 * contact's and this policy's alone. A row another policy's application also
 * points at (two policies in one coverage slot) is not "ours" to move or
 * restatus freely: that case goes through the slot path and its guard.
 */
async function priorEnrollmentFor(tx: Tx, orgId: string, contactId: string, policyId: string | null) {
  if (!policyId) return null;
  const [row] = await tx.select({ id: enrollmentsTable.id, carrierId: enrollmentsTable.carrierId })
    .from(enrollmentApplicationsTable)
    .innerJoin(enrollmentsTable, eq(enrollmentsTable.id, enrollmentApplicationsTable.enrollmentId))
    .where(and(
      eq(enrollmentApplicationsTable.orgId, orgId),
      eq(enrollmentApplicationsTable.source, APPLICATION_SOURCE),
      eq(enrollmentApplicationsTable.externalPolicyId, policyId),
      eq(enrollmentsTable.contactId, contactId),
    )).limit(1);
  if (!row) return null;
  const [shared] = await tx.select({ id: enrollmentApplicationsTable.id }).from(enrollmentApplicationsTable)
    .where(and(
      eq(enrollmentApplicationsTable.enrollmentId, row.id),
      ne(enrollmentApplicationsTable.externalPolicyId, policyId),
    )).limit(1);
  return shared ? null : row;
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
  let applicationKey = p.confirmationCode ?? (p.policyId ? `policy:${p.policyId}` : null);
  if (!applicationKey) return null;

  // Serialize writers for one policy so two deliveries can't both take
  // version N+1. Locked on the policy id when there is one, so a delivery that
  // first carries the confirmation code still serializes with earlier ones.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment-app:${orgId}:${p.policyId ?? applicationKey}`}, 0))`);

  // A delivery without the Sunfire code continues the record this policy
  // already has (whatever it is keyed on) rather than starting a second one.
  if (!p.confirmationCode && p.policyId) {
    const [known] = await tx.select({ key: enrollmentApplicationsTable.applicationKey }).from(enrollmentApplicationsTable)
      .where(and(
        eq(enrollmentApplicationsTable.orgId, orgId),
        eq(enrollmentApplicationsTable.source, APPLICATION_SOURCE),
        eq(enrollmentApplicationsTable.externalPolicyId, p.policyId),
      )).limit(1);
    if (known) applicationKey = known.key;
  }

  // The policy was first stored without a Sunfire code: re-key that record so
  // its history continues on one application instead of splitting in two. If
  // a record already holds the code (the same Sunfire application reached us
  // under another EnrollHere policy id), fold the code-less history into it.
  if (p.confirmationCode && p.policyId) {
    const fallbackKey = `policy:${p.policyId}`;
    const rows = await tx.select({
      id: enrollmentApplicationsTable.id,
      key: enrollmentApplicationsTable.applicationKey,
      policyId: enrollmentApplicationsTable.externalPolicyId,
      contactId: enrollmentApplicationsTable.contactId,
    })
      .from(enrollmentApplicationsTable)
      .where(and(
        eq(enrollmentApplicationsTable.orgId, orgId),
        eq(enrollmentApplicationsTable.source, APPLICATION_SOURCE),
        inArray(enrollmentApplicationsTable.applicationKey, [fallbackKey, p.confirmationCode]),
      ));
    const codeless = rows.find((r) => r.key === fallbackKey);
    const coded = rows.find((r) => r.key === p.confirmationCode);
    // A record holding this code for ANOTHER EnrollHere policy is a code
    // collision (vendor-side), even for the same person: merging would
    // overwrite that record's policy id and cross two policies' histories.
    // Keep this policy on its own fallback key and flag it.
    if (coded && coded.policyId && coded.policyId !== p.policyId) {
      logger.warn({ orgId, applicationId: coded.id }, "EnrollHere: Sunfire code already used by another policy; kept separate");
      applicationKey = fallbackKey;
    } else if (codeless && !coded) {
      await tx.update(enrollmentApplicationsTable).set({ applicationKey: p.confirmationCode })
        .where(eq(enrollmentApplicationsTable.id, codeless.id));
    } else if (codeless && coded) {
      const v = enrollmentApplicationVersionsTable;
      // Payloads the coded record already has are dropped; the rest are
      // appended after its latest version, keeping their order.
      await tx.execute(sql`
        DELETE FROM enrollment_application_versions d
        WHERE d.application_id = ${codeless.id}
          AND EXISTS (SELECT 1 FROM enrollment_application_versions k
                      WHERE k.application_id = ${coded.id} AND k.payload_hmac = d.payload_hmac)`);
      const [{ top } = { top: null }] = await tx.select({ top: max(v.version) }).from(v).where(eq(v.applicationId, coded.id));
      await tx.execute(sql`
        UPDATE enrollment_application_versions u SET application_id = ${coded.id}, version = r.n + ${top ?? 0}
        FROM (SELECT id, row_number() OVER (ORDER BY version) AS n
              FROM enrollment_application_versions WHERE application_id = ${codeless.id}) r
        WHERE u.id = r.id`);
      await tx.delete(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, codeless.id));
      const [{ newTop } = { newTop: null }] = await tx.select({ newTop: max(v.version) }).from(v).where(eq(v.applicationId, coded.id));
      if (newTop) await tx.update(enrollmentApplicationsTable).set({ currentVersion: newTop }).where(eq(enrollmentApplicationsTable.id, coded.id));
    }
  }


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
    medicareIdEncrypted: mbi?.encrypted ?? null,
    medicareIdHash: mbi?.hash ?? null,
    medicaidNumberEncrypted: medicaid,
  };
  const t = enrollmentApplicationsTable;
  const keep = (col: typeof t.carrierName | typeof t.planId | typeof t.planName | typeof t.planType | typeof t.snpType
    | typeof t.policyStatus | typeof t.effectiveDate | typeof t.signatureDate | typeof t.submittedAt
    | typeof t.agentEmail | typeof t.agentNpn | typeof t.confirmationCode | typeof t.externalPolicyId) =>
    sql`coalesce(excluded.${sql.identifier(col.name)}, ${col})`;
  const onUpdate = {
    lastEventType: p.eventType,
    // A partial update (status only) must not blank what an earlier delivery set.
    confirmationCode: keep(t.confirmationCode),
    externalPolicyId: keep(t.externalPolicyId),
    carrierName: keep(t.carrierName),
    planId: keep(t.planId),
    planName: keep(t.planName),
    planType: keep(t.planType),
    snpType: keep(t.snpType),
    policyStatus: keep(t.policyStatus),
    effectiveDate: keep(t.effectiveDate),
    signatureDate: keep(t.signatureDate),
    submittedAt: keep(t.submittedAt),
    agentEmail: keep(t.agentEmail),
    agentNpn: keep(t.agentNpn),
    // Identifiers follow the latest payload that carries the Medicare/Medicaid
    // sections: one that carries them without a number clears it, so a stale
    // number can't stay readable. A payload without those sections (e.g. a
    // name-only partial update) leaves them alone.
    ...(p.identifiersPresent ? {
      medicareIdEncrypted: promoted.medicareIdEncrypted,
      medicareIdHash: promoted.medicareIdHash,
      medicaidNumberEncrypted: promoted.medicaidNumberEncrypted,
    } : {}),
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
      ...onUpdate,
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
