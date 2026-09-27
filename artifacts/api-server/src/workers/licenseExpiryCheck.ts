/**
 * License Expiry Check Worker.
 *
 * Runs daily via pg-boss. Two jobs, in order:
 *
 *  1. Lapse sweep — any `active` license whose `expiry_date` has passed is
 *     flipped to `expired`, audited, and reported to the org's compliance
 *     roles. Without this a lapsed license stayed `active` forever: it kept
 *     scoring as compliant and the upcoming-expiry alerts (which only look at
 *     future dates) went silent the day it actually lapsed.
 *  2. Upcoming expiries — active licenses expiring within 90 days, deduplicated
 *     via license_renewal_alerts, with in-app notifications and emails to the
 *     agent, their manager and all compliance roles.
 *
 * Only agents who can still sell (`onboarding` / `active`) are alerted;
 * offboarded agents' licenses are still swept to `expired` for accuracy.
 */

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  stateLicensesTable,
  agentsTable,
  usersTable,
  notificationsTable,
  licenseRenewalAlertsTable,
  auditLogTable,
} from "@workspace/db";
import { type LicenseExpiryCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { licenseExpiryEmailHtml } from "../lib/email";
import { broadcastToUsers } from "../lib/sseManager";
import { logger } from "../lib/logger";

// Sorted ascending so .find() returns the smallest bucket that covers daysUntilExpiry.
// e.g. 45 days → 60-day threshold (not 90).
const ALERT_THRESHOLDS_DAYS = [7, 14, 30, 60, 90];

/** Licenses expired per run at most; a larger backlog drains over later runs. */
const MAX_LAPSES_PER_RUN = 500;

/** Above this many lapses in one run, an org gets one summary notification. */
const LAPSE_NOTICE_BATCH_THRESHOLD = 5;

/** Agent statuses whose credentials still matter for selling / alerts. */
const ALERTABLE_AGENT_STATUSES = ["onboarding", "active"] as const;

/**
 * Flip `active` licenses past their expiry date to `expired` (up to
 * MAX_LAPSES_PER_RUN per run, oldest first), write one audit row per license,
 * and notify compliance roles about lapses for agents who can still sell.
 * Returns the number of licenses expired.
 */
export async function expireLapsedLicenses(
  now: Date,
  orgId?: string,
): Promise<number> {
  type Lapsed = {
    licenseId: string;
    stateCode: string;
    licenseType: string;
    expiryDate: Date | null;
    agentId: string;
    agentStatus: string;
    agentFirstName: string;
    agentLastName: string;
    orgId: string;
  };
  // Lapses to report, grouped per org so a backlog becomes one summary
  // notification per org instead of a burst of one per license.
  const toNotify = new Map<string, Lapsed[]>();
  let expiredCount = 0;

  // One transaction per run, serialized by an advisory lock: an overlapping
  // or redispatched run waits, then finds nothing left to flip. Each run is
  // capped so a large first-deploy backlog drains over successive daily runs
  // instead of in one burst.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('license_lapse_sweep'))`);

    const lapsed = await tx
      .select({
        licenseId: stateLicensesTable.id,
        stateCode: stateLicensesTable.stateCode,
        licenseType: stateLicensesTable.licenseType,
        expiryDate: stateLicensesTable.expiryDate,
        agentId: agentsTable.id,
        agentStatus: agentsTable.status,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
        orgId: agentsTable.orgId,
      })
      .from(stateLicensesTable)
      .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
      .where(
        and(
          eq(stateLicensesTable.status, "active"),
          lt(stateLicensesTable.expiryDate, now),
          orgId ? eq(agentsTable.orgId, orgId) : undefined,
        ),
      )
      .orderBy(stateLicensesTable.expiryDate)
      .limit(MAX_LAPSES_PER_RUN);

    for (const lic of lapsed) {
      const updated = await tx
        .update(stateLicensesTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(stateLicensesTable.id, lic.licenseId),
            eq(stateLicensesTable.status, "active"),
            lt(stateLicensesTable.expiryDate, now),
          ),
        )
        .returning({ id: stateLicensesTable.id });
      if (updated.length === 0) continue;
      expiredCount++;

      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: lic.orgId,
        userId: "system",
        userRole: null,
        action: "license_auto_expired",
        resourceType: "license",
        resourceId: lic.licenseId,
        changes: {
          agentId: lic.agentId,
          stateCode: lic.stateCode,
          licenseType: lic.licenseType,
          expiryDate: lic.expiryDate?.toISOString() ?? null,
          from: "active",
          to: "expired",
        },
      });

      if (!(ALERTABLE_AGENT_STATUSES as readonly string[]).includes(lic.agentStatus)) continue;
      const list = toNotify.get(lic.orgId) ?? [];
      list.push(lic);
      toNotify.set(lic.orgId, list);
    }
  });

  if (expiredCount === 0) return 0;

  for (const [orgId, lics] of toNotify) {
    const admins = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, orgId),
          inArray(usersTable.role, ["super_admin", "agency_admin", "compliance_manager"]),
          eq(usersTable.isActive, true),
        ),
      );
    const adminIds = admins.map((a) => a.id);
    if (adminIds.length === 0) continue;

    const notices =
      lics.length <= LAPSE_NOTICE_BATCH_THRESHOLD
        ? lics.map((lic) => ({
            title: `License lapsed — ${lic.stateCode}`,
            body: `${lic.agentFirstName} ${lic.agentLastName}: ${lic.stateCode} ${lic.licenseType} expired ${lic.expiryDate?.toLocaleDateString() ?? ""}. The agent is no longer ready to sell in ${lic.stateCode}.`,
            resourceType: "license",
            resourceId: lic.licenseId,
          }))
        : [
            {
              title: `${lics.length} licenses lapsed`,
              body: `${lics.length} active-agent licenses were past their expiry date and have been marked expired. Those agents are no longer ready to sell in the affected states — review the readiness board.`,
              resourceType: "org",
              resourceId: orgId,
            },
          ];

    const rows = notices.flatMap((n) =>
      adminIds.map((uid) => ({ id: randomUUID(), orgId, userId: uid, type: "license_lapsed", priority: "high", ...n })),
    );
    await db.insert(notificationsTable).values(rows).onConflictDoNothing();
    broadcastToUsers(adminIds, { type: "notification", resourceType: "license", resourceId: orgId });
  }

  logger.info({ count: expiredCount }, "License lapse sweep: expired lapsed licenses");
  return expiredCount;
}

export async function licenseExpiryCheckWorker(
  data: LicenseExpiryCheckPayload,
): Promise<void> {
  const now = new Date();

  await expireLapsedLicenses(now, data.orgId);
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const baseConditions = [
    eq(stateLicensesTable.status, "active"),
    inArray(agentsTable.status, [...ALERTABLE_AGENT_STATUSES]),
    sql`${stateLicensesTable.expiryDate} IS NOT NULL`,
    sql`${stateLicensesTable.expiryDate} > ${now}`,
    sql`${stateLicensesTable.expiryDate} <= ${in90}`,
  ];

  const whereCondition = data.orgId
    ? and(...baseConditions, eq(agentsTable.orgId, data.orgId))
    : and(...baseConditions);

  const expiringLicenses = await db
    .select({
      licenseId: stateLicensesTable.id,
      agentId: stateLicensesTable.agentId,
      stateCode: stateLicensesTable.stateCode,
      licenseType: stateLicensesTable.licenseType,
      expiryDate: stateLicensesTable.expiryDate,
      agentFirstName: agentsTable.firstName,
      agentLastName: agentsTable.lastName,
      agentEmail: agentsTable.email,
      orgId: agentsTable.orgId,
      agentUserId: agentsTable.userId,
      managerId: agentsTable.managerId,
    })
    .from(stateLicensesTable)
    .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
    .where(whereCondition);

  logger.info(
    { count: expiringLicenses.length },
    "License expiry check: found expiring licenses",
  );

  for (const license of expiringLicenses) {
    if (!license.expiryDate) continue;

    const daysUntilExpiry = Math.ceil(
      (license.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Fire one alert per milestone threshold that has been crossed (daysUntil <= threshold)
    // and has not yet been sent. This ensures each milestone (90/60/30/14/7) fires exactly
    // once, independently — not just the single "nearest" bucket.
    const crossedThresholds = ALERT_THRESHOLDS_DAYS.filter((t) => daysUntilExpiry <= t);
    if (crossedThresholds.length === 0) continue;

    // Load all existing alert records for this license in one query
    const existingAlerts = await db
      .select({ id: licenseRenewalAlertsTable.id, alertDaysBefore: licenseRenewalAlertsTable.alertDaysBefore, sentAt: licenseRenewalAlertsTable.sentAt })
      .from(licenseRenewalAlertsTable)
      .where(eq(licenseRenewalAlertsTable.licenseId, license.licenseId));

    const alreadySentSet = new Set(
      existingAlerts.filter((a) => a.sentAt).map((a) => a.alertDaysBefore),
    );

    const pendingThresholds = crossedThresholds.filter((t) => !alreadySentSet.has(t));
    if (pendingThresholds.length === 0) continue;
    // Only the most urgent unsent milestone produces an alert. A license first
    // seen with 5 days left would otherwise send the 90/60/30/14/7 emails all
    // at once; the wider milestones are recorded as covered by this one.
    const alertThreshold = Math.min(...pendingThresholds);

    // Fetch org-level admins/compliance roles for oversight notifications
    const orgAdmins = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, license.orgId),
          sql`${usersTable.role} IN ('super_admin', 'agency_admin', 'compliance_manager')`,
          eq(usersTable.isActive, true),
        ),
      );

    // Fetch the agent's assigned manager (if any) — may not be in org admin roles
    let managerUser: { id: string; email: string } | null = null;
    if (license.managerId) {
      const [mu] = await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(and(eq(usersTable.id, license.managerId), eq(usersTable.isActive, true)))
        .limit(1);
      managerUser = mu ?? null;
    }

    // Build deduplicated recipient sets: org admins + manager + agent user
    const notifUserIdSet = new Set<string>(orgAdmins.map((a) => a.id));
    if (managerUser) notifUserIdSet.add(managerUser.id);
    if (license.agentUserId) notifUserIdSet.add(license.agentUserId);
    const notifUserIds = Array.from(notifUserIdSet);

    const emailSet = new Set<string>();
    if (license.agentEmail) emailSet.add(license.agentEmail);
    if (managerUser?.email) emailSet.add(managerUser.email);
    orgAdmins.forEach((a) => { if (a.email) emailSet.add(a.email); });

    for (const threshold of pendingThresholds) {
      const isAlert = threshold === alertThreshold;
      // Create in-app notifications for agent + manager + org admins
      const notifInserts = notifUserIds.map((uid) => ({
        id: randomUUID(),
        orgId: license.orgId,
        userId: uid,
        type: "license_expiry_alert",
        title: `License expiring in ${daysUntilExpiry} days`,
        body: `${license.agentFirstName} ${license.agentLastName}: ${license.stateCode} ${license.licenseType} expires ${license.expiryDate!.toLocaleDateString()}`,
        resourceType: "license",
        resourceId: license.licenseId,
        priority: daysUntilExpiry <= 30 ? "high" : "normal",
      }));

      let firstNotifId: string | null = null;
      if (isAlert && notifInserts.length > 0) {
        firstNotifId = notifInserts[0].id;
        await db.insert(notificationsTable).values(notifInserts).onConflictDoNothing();
        broadcastToUsers(
          notifInserts.map((n) => n.userId),
          { type: "notification", resourceType: "license", resourceId: license.licenseId },
        );
      }

      // Send email to agent + manager + org admins
      const emailHtml = licenseExpiryEmailHtml({
        agentName: `${license.agentFirstName} ${license.agentLastName}`,
        stateCode: license.stateCode,
        licenseType: license.licenseType,
        daysUntilExpiry,
        expiryDate: license.expiryDate!.toLocaleDateString(),
      });

      const emailRecipients = Array.from(emailSet);

      if (isAlert && emailRecipients.length > 0) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
          to: emailRecipients,
          subject: `License expiring in ${daysUntilExpiry} days — ${license.stateCode} ${license.licenseType}`,
          html: emailHtml,
          tags: { licenseId: license.licenseId, threshold: String(threshold) },
        });
      }

      // Record alert for this threshold (upsert)
      const existingRow = existingAlerts.find((a) => a.alertDaysBefore === threshold);
      if (existingRow) {
        await db
          .update(licenseRenewalAlertsTable)
          .set({ sentAt: now, notificationId: firstNotifId })
          .where(eq(licenseRenewalAlertsTable.id, existingRow.id));
      } else {
        await db.insert(licenseRenewalAlertsTable).values({
          id: randomUUID(),
          licenseId: license.licenseId,
          alertDaysBefore: threshold,
          sentAt: now,
          notificationId: firstNotifId,
        }).onConflictDoNothing();
      }

      logger.info(
        { licenseId: license.licenseId, threshold, daysUntilExpiry },
        "License expiry alert sent",
      );
    }
  }

  logger.info("License expiry check worker complete");
}
