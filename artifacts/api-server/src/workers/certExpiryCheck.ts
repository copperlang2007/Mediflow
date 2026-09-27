/**
 * Carrier Certification Expiry Check Worker.
 *
 * Runs daily via pg-boss at 08:05 UTC. Finds passed certifications expiring
 * within 90 days, deduplicates via cert_renewal_alerts table (one alert per
 * cert per threshold, never repeats), creates in-app notifications, and
 * enqueues reminder emails to BOTH the agent AND all compliance managers.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  carrierCertificationsTable,
  carriersTable,
  agentsTable,
  usersTable,
  notificationsTable,
  certRenewalAlertsTable,
} from "@workspace/db";
import { type CertExpiryCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { certExpiryEmailHtml } from "../lib/email";
import { broadcastToUsers } from "../lib/sseManager";
import { logger } from "../lib/logger";

// Sorted ascending so .find() returns the smallest bucket that covers daysUntilExpiry.
const ALERT_THRESHOLDS_DAYS = [7, 14, 30, 60, 90];

export async function certExpiryCheckWorker(
  data: CertExpiryCheckPayload,
): Promise<void> {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const baseConditions = [
    inArray(carrierCertificationsTable.status, ["passed", "waived"]),
    // Offboarded / suspended agents don't need renewal nags.
    inArray(agentsTable.status, ["onboarding", "active"]),
    sql`${carrierCertificationsTable.expiryDate} IS NOT NULL`,
    sql`${carrierCertificationsTable.expiryDate} > ${now}`,
    sql`${carrierCertificationsTable.expiryDate} <= ${in90}`,
  ];

  const whereCondition = data.orgId
    ? and(...baseConditions, eq(agentsTable.orgId, data.orgId))
    : and(...baseConditions);

  const expiringCerts = await db
    .select({
      certId: carrierCertificationsTable.id,
      agentId: carrierCertificationsTable.agentId,
      carrierId: carrierCertificationsTable.carrierId,
      carrierName: carriersTable.name,
      certificationYear: carrierCertificationsTable.certificationYear,
      expiryDate: carrierCertificationsTable.expiryDate,
      agentFirstName: agentsTable.firstName,
      agentLastName: agentsTable.lastName,
      agentEmail: agentsTable.email,
      orgId: agentsTable.orgId,
      agentUserId: agentsTable.userId,
      managerId: agentsTable.managerId,
    })
    .from(carrierCertificationsTable)
    .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
    .innerJoin(carriersTable, eq(carrierCertificationsTable.carrierId, carriersTable.id))
    .where(whereCondition);

  logger.info(
    { count: expiringCerts.length },
    "Cert expiry check: found expiring certifications",
  );

  for (const cert of expiringCerts) {
    if (!cert.expiryDate) continue;

    const daysUntilExpiry = Math.ceil(
      (cert.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Fire one alert per milestone threshold that has been crossed (daysUntil <= threshold)
    // and has not yet been sent. Each milestone (90/60/30/14/7) fires independently.
    const crossedThresholds = ALERT_THRESHOLDS_DAYS.filter((t) => daysUntilExpiry <= t);
    if (crossedThresholds.length === 0) continue;

    // Load all existing alert records for this cert in one query
    const existingAlerts = await db
      .select({ id: certRenewalAlertsTable.id, alertDaysBefore: certRenewalAlertsTable.alertDaysBefore, sentAt: certRenewalAlertsTable.sentAt })
      .from(certRenewalAlertsTable)
      .where(eq(certRenewalAlertsTable.certId, cert.certId));

    const alreadySentSet = new Set(
      existingAlerts.filter((a) => a.sentAt).map((a) => a.alertDaysBefore),
    );

    const pendingThresholds = crossedThresholds.filter((t) => !alreadySentSet.has(t));
    if (pendingThresholds.length === 0) continue;
    // Only the most urgent unsent milestone produces an alert. A cert first
    // seen with 5 days left would otherwise send the 90/60/30/14/7 emails all
    // at once; the wider milestones are recorded as covered by this one.
    const alertThreshold = Math.min(...pendingThresholds);

    // Fetch org-level admins/compliance roles for oversight notifications
    const orgAdmins = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, cert.orgId),
          sql`${usersTable.role} IN ('super_admin', 'agency_admin', 'compliance_manager')`,
          eq(usersTable.isActive, true),
        ),
      );

    // Fetch the agent's assigned manager (if any) — may not be in org admin roles
    let managerUser: { id: string; email: string } | null = null;
    if (cert.managerId) {
      const [mu] = await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(and(eq(usersTable.id, cert.managerId), eq(usersTable.isActive, true)))
        .limit(1);
      managerUser = mu ?? null;
    }

    // Build deduplicated recipient sets: org admins + manager + agent user
    const notifUserIdSet = new Set<string>(orgAdmins.map((a) => a.id));
    if (managerUser) notifUserIdSet.add(managerUser.id);
    if (cert.agentUserId) notifUserIdSet.add(cert.agentUserId);
    const notifUserIds = Array.from(notifUserIdSet);

    const emailSet = new Set<string>();
    if (cert.agentEmail) emailSet.add(cert.agentEmail);
    if (managerUser?.email) emailSet.add(managerUser.email);
    orgAdmins.forEach((a) => { if (a.email) emailSet.add(a.email); });

    for (const threshold of pendingThresholds) {
      const isAlert = threshold === alertThreshold;
      // Create in-app notifications for agent + manager + org admins
      const notifInserts = notifUserIds.map((uid) => ({
        id: randomUUID(),
        orgId: cert.orgId,
        userId: uid,
        type: "cert_expiry_alert",
        title: `Certification expiring in ${daysUntilExpiry} days`,
        body: `${cert.agentFirstName} ${cert.agentLastName}: ${cert.carrierName} (${cert.certificationYear}) expires ${cert.expiryDate!.toLocaleDateString()}`,
        resourceType: "certification",
        resourceId: cert.certId,
        priority: daysUntilExpiry <= 30 ? "high" : "normal",
      }));

      let firstNotifId: string | null = null;
      if (isAlert && notifInserts.length > 0) {
        firstNotifId = notifInserts[0].id;
        await db.insert(notificationsTable).values(notifInserts).onConflictDoNothing();
        broadcastToUsers(
          notifInserts.map((n) => n.userId),
          { type: "notification", resourceType: "certification", resourceId: cert.certId },
        );
      }

      // Send email to agent + manager + org admins
      const emailHtml = certExpiryEmailHtml({
        agentName: `${cert.agentFirstName} ${cert.agentLastName}`,
        carrierName: cert.carrierName,
        certificationYear: cert.certificationYear,
        daysUntilExpiry,
        expiryDate: cert.expiryDate!.toLocaleDateString(),
      });

      const emailRecipients = Array.from(emailSet);

      if (isAlert && emailRecipients.length > 0) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
          to: emailRecipients,
          subject: `Certification expiring in ${daysUntilExpiry} days — ${cert.carrierName}`,
          html: emailHtml,
          tags: { certId: cert.certId, threshold: String(threshold) },
        });
      }

      // Record alert for this threshold (upsert)
      const existingRow = existingAlerts.find((a) => a.alertDaysBefore === threshold);
      if (existingRow) {
        await db
          .update(certRenewalAlertsTable)
          .set({ sentAt: now, notificationId: firstNotifId })
          .where(eq(certRenewalAlertsTable.id, existingRow.id));
      } else {
        await db.insert(certRenewalAlertsTable).values({
          id: randomUUID(),
          certId: cert.certId,
          alertDaysBefore: threshold,
          sentAt: now,
          notificationId: firstNotifId,
        }).onConflictDoNothing();
      }

      logger.info(
        { certId: cert.certId, threshold, daysUntilExpiry },
        "Cert expiry alert sent",
      );
    }
  }

  logger.info("Cert expiry check worker complete");
}
