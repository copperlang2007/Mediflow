/**
 * Carrier Certification Expiry Check Worker.
 *
 * Runs daily via pg-boss. Finds carrier certifications expiring within 90 days
 * and creates in-app notifications.
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  carrierCertificationsTable,
  agentsTable,
  usersTable,
  notificationsTable,
} from "@workspace/db";
import { type CertExpiryCheckPayload } from "../lib/jobs";
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
      certificationYear: carrierCertificationsTable.certificationYear,
      expiryDate: carrierCertificationsTable.expiryDate,
      agentFirstName: agentsTable.firstName,
      agentLastName: agentsTable.lastName,
      orgId: agentsTable.orgId,
    })
    .from(carrierCertificationsTable)
    .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
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
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, cert.orgId),
          sql`${usersTable.role} IN ('super_admin', 'agency_admin', 'compliance_manager')`,
          eq(usersTable.isActive, true),
        ),
      );

    const notifInserts = orgAdmins.map((admin) => ({
      id: randomUUID(),
      orgId: cert.orgId,
      userId: admin.id,
      type: "cert_expiry_alert",
      title: `Carrier cert expiring in ${daysUntilExpiry} days`,
      body: `${cert.agentFirstName} ${cert.agentLastName}: ${cert.carrierId} (${cert.certificationYear}) expires ${cert.expiryDate!.toLocaleDateString()}`,
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
  }

  logger.info("Cert expiry check worker complete");
}
