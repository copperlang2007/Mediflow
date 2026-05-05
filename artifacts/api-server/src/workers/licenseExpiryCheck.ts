/**
 * License Expiry Check Worker.
 *
 * Runs daily via pg-boss. Finds active licenses expiring within 90 days,
 * deduplicates via license_renewal_alerts table, creates in-app notifications,
 * and enqueues reminder emails to BOTH the agent AND all compliance managers.
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  stateLicensesTable,
  agentsTable,
  usersTable,
  notificationsTable,
  licenseRenewalAlertsTable,
} from "@workspace/db";
import { type LicenseExpiryCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { licenseExpiryEmailHtml } from "../lib/email";
import { broadcastToUsers } from "../lib/sseManager";
import { logger } from "../lib/logger";

// Sorted ascending so .find() returns the smallest bucket that covers daysUntilExpiry.
// e.g. 45 days → 60-day threshold (not 90).
const ALERT_THRESHOLDS_DAYS = [7, 14, 30, 60, 90];

export async function licenseExpiryCheckWorker(
  data: LicenseExpiryCheckPayload,
): Promise<void> {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const baseConditions = [
    eq(stateLicensesTable.status, "active"),
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
      if (notifInserts.length > 0) {
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

      if (emailRecipients.length > 0) {
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
