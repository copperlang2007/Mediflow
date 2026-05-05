/**
 * Carrier Certification Expiry Check Worker.
 *
 * Runs daily via pg-boss at 08:05 UTC. Finds passed certifications expiring
 * within 90 days, creates in-app notifications (deduplicated within 24h),
 * and enqueues reminder emails for certs expiring within 30 days.
 */

import { and, eq, sql, gt } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  carrierCertificationsTable,
  carriersTable,
  agentsTable,
  usersTable,
  notificationsTable,
} from "@workspace/db";
import { type CertExpiryCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { certExpiryEmailHtml } from "../lib/email";
import { broadcastToUsers } from "../lib/sseManager";
import { logger } from "../lib/logger";

const ALERT_THRESHOLDS_DAYS = [90, 60, 30, 14, 7];

export async function certExpiryCheckWorker(
  data: CertExpiryCheckPayload,
): Promise<void> {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const baseConditions = [
    eq(carrierCertificationsTable.status, "passed"),
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

    const nearestThreshold = ALERT_THRESHOLDS_DAYS.find((t) => daysUntilExpiry <= t);
    if (!nearestThreshold) continue;

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

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const existingNotifs = await db
      .select({ userId: notificationsTable.userId })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.type, "cert_expiry_alert"),
          eq(notificationsTable.resourceId, cert.certId),
          gt(notificationsTable.createdAt, yesterday),
        ),
      );
    const alreadyNotified = new Set(existingNotifs.map((n) => n.userId));

    const notifInserts = orgAdmins
      .filter((admin) => !alreadyNotified.has(admin.id))
      .map((admin) => ({
        id: randomUUID(),
        orgId: cert.orgId,
        userId: admin.id,
        type: "cert_expiry_alert",
        title: `Certification expiring in ${daysUntilExpiry} days`,
        body: `${cert.agentFirstName} ${cert.agentLastName}: ${cert.carrierName} (${cert.certificationYear}) expires ${cert.expiryDate!.toLocaleDateString()}`,
        resourceType: "certification",
        resourceId: cert.certId,
        priority: daysUntilExpiry <= 30 ? "high" : "normal",
      }));

    if (notifInserts.length > 0) {
      await db.insert(notificationsTable).values(notifInserts).onConflictDoNothing();
      broadcastToUsers(
        notifInserts.map((n) => n.userId),
        { type: "notification", resourceType: "certification", resourceId: cert.certId },
      );
    }

    if (daysUntilExpiry <= 30 && cert.agentEmail) {
      await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
        to: cert.agentEmail,
        subject: `Certification expiring in ${daysUntilExpiry} days — ${cert.carrierName}`,
        html: certExpiryEmailHtml({
          agentName: `${cert.agentFirstName} ${cert.agentLastName}`,
          carrierName: cert.carrierName,
          certificationYear: cert.certificationYear,
          daysUntilExpiry,
          expiryDate: cert.expiryDate.toLocaleDateString(),
        }),
      });
    }
  }

  logger.info("Cert expiry check worker complete");
}
