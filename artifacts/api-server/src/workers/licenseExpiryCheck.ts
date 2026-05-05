/**
 * License Expiry Check Worker.
 *
 * Runs daily via pg-boss. Finds active licenses expiring within 90 days,
 * creates in-app notifications, and enqueues reminder emails.
 */

import { and, eq, sql, not, exists } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  stateLicensesTable,
  agentsTable,
  usersTable,
  notificationsTable,
} from "@workspace/db";
import { type LicenseExpiryCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { licenseExpiryEmailHtml } from "../lib/email";
import { logger } from "../lib/logger";

const ALERT_THRESHOLDS_DAYS = [90, 60, 30, 14, 7];

export async function licenseExpiryCheckWorker(
  data: LicenseExpiryCheckPayload,
): Promise<void> {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const baseConditions = [
    eq(stateLicensesTable.status, "active"),
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

    const expiryMs = license.expiryDate.getTime();
    const daysUntilExpiry = Math.ceil((expiryMs - now.getTime()) / (1000 * 60 * 60 * 24));

    const nearestThreshold = ALERT_THRESHOLDS_DAYS.find((t) => daysUntilExpiry <= t);
    if (!nearestThreshold) continue;

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

    if (notifInserts.length > 0) {
      await db.insert(notificationsTable).values(notifInserts).onConflictDoNothing();
    }

    if (daysUntilExpiry <= 30 && license.agentEmail) {
      await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
        to: license.agentEmail,
        subject: `License expiring in ${daysUntilExpiry} days — ${license.stateCode} ${license.licenseType}`,
        html: licenseExpiryEmailHtml({
          agentName: `${license.agentFirstName} ${license.agentLastName}`,
          stateCode: license.stateCode,
          licenseType: license.licenseType,
          daysUntilExpiry,
          expiryDate: license.expiryDate.toLocaleDateString(),
        }),
      });
    }
  }

  logger.info("License expiry check worker complete");
}
