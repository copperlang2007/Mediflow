/**
 * Writes a policy application: the enrollment row and the full application
 * record (encrypted, versioned). Used by the EnrollHere receiver and by the
 * GoHighLevel sync for Sunfire applications carried in custom fields.
 *
 * Application record rules:
 *   - one record per (org, source, applicationKey); the key is the Sunfire
 *     confirmation code, or `policy:<EnrollHere policy id>` (or the caller's
 *     fallback key) when there is none;
 *   - every distinct payload is kept as an encrypted version (AES-GCM, the
 *     same PHI key as contact data); an identical redelivery adds nothing;
 *   - only plan / carrier / dates / status / agent are plain columns; the
 *     Medicare and Medicaid numbers are encrypted columns; health answers and
 *     race/ethnicity exist only inside the encrypted payload.
 */
import { randomUUID } from "crypto";
import { and, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import {
  contactsTable,
  enrollmentsTable,
  enrollmentApplicationsTable,
  enrollmentApplicationVersionsTable,
  encryptMedicareId,
  encryptPii,
} from "@workspace/db";
import { canonicalJson } from "../payload";
import { resolveCarrier, type Tx } from "../../contactImport";
import { syncContactCoverageProjection } from "../../../routes/enrollments";
import { isEndedStatus, mapPolicyStatus, type ParsedPolicyEvent } from "./policyEvent";
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
  note = "From EnrollHere",
): Promise<string | null> {
  if (!p.planType || !p.effectiveDate) return null;
  let carrierId = p.carrierName ? await resolveCarrier(tx, orgId, p.carrierName, new Map(), []) : null;
  const { status, effectuated } = mapPolicyStatus(p.policyStatus);
  const planYear = Number(p.effectiveDate.slice(0, 4));

  // The policy's own enrollment, found through its stored application: an
  // update lands there even when the carrier, plan type or plan year changed.
  const prior = await priorEnrollmentFor(tx, orgId, contactId, p.policyId);
  if (prior?.shared) {
    // Another policy shares this row: never move it, and a policy that isn't
    // in force doesn't end coverage another sharing policy still reports.
    if (p.policyStatus && (effectuated || !prior.othersInForce)) {
      await tx.update(enrollmentsTable).set({ status, effectuated }).where(eq(enrollmentsTable.id, prior.id));
      await syncContactCoverageProjection(contactId, orgId, tx);
    }
    return prior.id;
  }
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
    // The new slot already holds another enrollment: leave this policy on its
    // own row rather than re-linking it to someone else's.
    logger.warn({ orgId, contactId, enrollmentId: prior.id }, "EnrollHere: policy moved onto an occupied enrollment slot; left in place");
    if (p.policyStatus) {
      await tx.update(enrollmentsTable).set({ status, effectuated }).where(eq(enrollmentsTable.id, prior.id));
      await syncContactCoverageProjection(contactId, orgId, tx);
    }
    return prior.id;
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
    // Only a row no other policy's application points at: another policy's
    // carrier-less enrollment is not this one arriving late.
    // Without a policy id there's no way to tell, so nothing is promoted.
    const [othersRow] = carrierless && p.policyId ? await tx.select({ id: enrollmentApplicationsTable.id })
      .from(enrollmentApplicationsTable)
      .where(and(eq(enrollmentApplicationsTable.enrollmentId, carrierless.id), ne(enrollmentApplicationsTable.externalPolicyId, p.policyId)))
      .limit(1) : [];
    if (carrierless && p.policyId && !othersRow) {
      await tx.update(enrollmentsTable).set({ carrierId }).where(eq(enrollmentsTable.id, carrierless.id));
    }
  }
  // This path only runs when the policy's own enrollment wasn't found above,
  // so a row already in the slot belongs to something else: a manual or CSV
  // entry, or another policy (a plan switch within the same carrier). A
  // policy that is not in force never overwrites that row's status; one in
  // force does (EnrollHere is authoritative when it reports coverage).
  const [elsewhere] = await tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable)
    .where(and(
      eq(enrollmentsTable.contactId, contactId),
      eq(enrollmentsTable.planYear, planYear),
      eq(enrollmentsTable.planType, p.planType),
      carrierId ? eq(enrollmentsTable.carrierId, carrierId) : isNull(enrollmentsTable.carrierId),
    )).limit(1);
  // An update that carries no status at all leaves the status alone.
  const keepStatus = !p.policyStatus || (!!elsewhere && !effectuated);

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
    notes: note,
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
 * Lifecycle follows coverage. In force: a lead or prospect becomes an enrolled
 * client (so retention and AEP renewals include them). Ended (cancelled,
 * terminated, declined, inactive): an enrolled client with no other in-force
 * coverage becomes "lost", a former client, not a new prospect. Other statuses
 * (retained, lost, do_not_contact) are the agency's call and are left alone.
 */
export async function applyCoverageLifecycle(
  tx: Tx,
  contactId: string,
  enrollmentId: string | null,
  policyStatus: string | null,
): Promise<void> {
  if (!enrollmentId) return;
  if (mapPolicyStatus(policyStatus).effectuated) {
    await tx.update(contactsTable).set({ status: "enrolled" })
      .where(and(eq(contactsTable.id, contactId), inArray(contactsTable.status, ["lead", "prospect"])));
  } else if (isEndedStatus(policyStatus)) {
    const [stillCovered] = await tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable)
      .where(and(eq(enrollmentsTable.contactId, contactId), eq(enrollmentsTable.effectuated, true))).limit(1);
    if (!stillCovered) {
      await tx.update(contactsTable).set({ status: "lost" })
        .where(and(eq(contactsTable.id, contactId), eq(contactsTable.status, "enrolled")));
    }
  }
}

/**
 * The enrollment an earlier delivery of this policy created, if it's still this
 * contact's. `shared` when another policy's application also points at it (two
 * policies in one coverage slot); `othersInForce` when one of those reports
 * coverage in force.
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
  const others = await tx.select({ policyStatus: enrollmentApplicationsTable.policyStatus }).from(enrollmentApplicationsTable)
    .where(and(
      eq(enrollmentApplicationsTable.enrollmentId, row.id),
      ne(enrollmentApplicationsTable.externalPolicyId, policyId),
    ));
  return {
    ...row,
    shared: others.length > 0,
    othersInForce: others.some((o) => mapPolicyStatus(o.policyStatus).effectuated),
  };
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
  opts: {
    source?: string;
    fallbackKey?: string | null;
    /** The agent profile that wrote it (resolved unambiguously by the caller). */
    writingAgentId?: string | null;
  } = {},
): Promise<StoredApplication | null> {
  const source = opts.source ?? APPLICATION_SOURCE;
  let applicationKey = p.confirmationCode ?? (p.policyId ? `policy:${p.policyId}` : null) ?? opts.fallbackKey ?? null;
  if (!applicationKey) return null;

  // The key this application had before it carried a Sunfire code: the
  // EnrollHere policy id, or the caller's fallback (GHL: contact + plan).
  const codelessKey = p.policyId ? `policy:${p.policyId}` : opts.fallbackKey ?? null;

  // Serialize writers for one policy so two deliveries can't both take
  // version N+1. Locked on the policy id (or the caller's fallback key) when
  // there is one, so a delivery that first carries the confirmation code still
  // serializes with earlier ones. The EnrollHere lock string is unchanged, so
  // old and new servers still exclude each other during a rolling deploy.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment-app:${orgId}:${p.policyId ?? codelessKey ?? applicationKey}`}, 0))`);

  // A delivery without the Sunfire code continues the record this policy
  // already has (whatever it is keyed on) rather than starting a second one.
  if (!p.confirmationCode && p.policyId) {
    const [known] = await tx.select({ key: enrollmentApplicationsTable.applicationKey }).from(enrollmentApplicationsTable)
      .where(and(
        eq(enrollmentApplicationsTable.orgId, orgId),
        eq(enrollmentApplicationsTable.source, source),
        eq(enrollmentApplicationsTable.externalPolicyId, p.policyId),
      )).limit(1);
    if (known) applicationKey = known.key;
  }

  // The policy was first stored without a Sunfire code: re-key that record so
  // its history continues on one application instead of splitting in two. A
  // code already held by another policy's record is never taken over.
  if (p.confirmationCode && codelessKey) {
    const fallbackKey = codelessKey;
    const rows = await tx.select({
      id: enrollmentApplicationsTable.id,
      key: enrollmentApplicationsTable.applicationKey,
      policyId: enrollmentApplicationsTable.externalPolicyId,
      contactId: enrollmentApplicationsTable.contactId,
    })
      .from(enrollmentApplicationsTable)
      .where(and(
        eq(enrollmentApplicationsTable.orgId, orgId),
        eq(enrollmentApplicationsTable.source, source),
        inArray(enrollmentApplicationsTable.applicationKey, [fallbackKey, p.confirmationCode]),
      ));
    const codeless = rows.find((r) => r.key === fallbackKey);
    const coded = rows.find((r) => r.key === p.confirmationCode);
    // A record holding this code for ANOTHER EnrollHere policy is a code
    // collision (vendor-side), even for the same person: merging would cross
    // two policies' histories. Keep this policy on its own fallback key and
    // flag it. A coded record with no policy id yet is this application
    // arriving without one earlier; it learns the id from this delivery.
    if (coded && coded.policyId && coded.policyId !== p.policyId) {
      logger.warn({ orgId, applicationId: coded.id }, "EnrollHere: Sunfire code already used by another policy; kept separate");
      applicationKey = fallbackKey;
    } else if (coded && !coded.policyId && !p.policyId && coded.contactId && links.contactId && coded.contactId !== links.contactId) {
      // No policy ids to compare (GHL): the same code on a different person is
      // a collision too. Taking the record over would put this person's
      // payload in another person's application history.
      logger.warn({ orgId, applicationId: coded.id }, "Sunfire code already used by another contact's application; kept separate");
      applicationKey = fallbackKey;
    } else if (codeless && !coded) {
      await tx.update(enrollmentApplicationsTable).set({ applicationKey: p.confirmationCode })
        .where(eq(enrollmentApplicationsTable.id, codeless.id));
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
    writingAgentId: opts.writingAgentId ?? null,
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
    // A record keeps the policy id it was created for.
    externalPolicyId: sql`coalesce(${t.externalPolicyId}, excluded.external_policy_id)`,
    // The writer is fixed once known; a later delivery only fills a blank.
    writingAgentId: sql`coalesce(${t.writingAgentId}, excluded.writing_agent_id)`,
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
    source,
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
