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

    // Fetch compliance managers + admins once per license (shared across all pending thresholds)
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

    for (const threshold of pendingThresholds) {
      // Create in-app notifications for managers
      const notifInserts = orgAdmins.map((admin) => ({
        id: randomUUID(),
        orgId: license.orgId,
        userId: admin.id,
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

      // Send email to agent AND all managers
      const emailHtml = licenseExpiryEmailHtml({
        agentName: `${license.agentFirstName} ${license.agentLastName}`,
        stateCode: license.stateCode,
        licenseType: license.licenseType,
        daysUntilExpiry,
        expiryDate: license.expiryDate!.toLocaleDateString(),
      });

      const emailRecipients: string[] = [];
      if (license.agentEmail) emailRecipients.push(license.agentEmail);
      orgAdmins.forEach((a) => { if (a.email) emailRecipients.push(a.email); });

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
