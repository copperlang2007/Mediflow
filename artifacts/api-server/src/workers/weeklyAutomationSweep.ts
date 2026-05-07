/**
 * Daily Automation Sweep Worker.
 *
 * Runs nightly at 01:00 UTC. For every active org, performs trigger-specific
 * DB scans and enqueues `run-automation-rules` for each matching record so that
 * time-based automation rules fire on a daily cadence.
 *
 * Triggers scanned here:
 *   license_expiring       — state licenses expiring within 30/60/90 days
 *   cert_expiring          — carrier certs expiring within 30/60/90 days
 *   ahip_deadline          — AHIP records not completed for current cert year
 *   contact_no_activity    — contacts with no logged activity in 30+ days
 *   task_overdue           — open/in-progress tasks past their due date
 *   scheduled              — catch-all for rules that fire on any nightly sweep
 */

import { and, eq, isNull, lt, lte, gte, isNotNull, inArray, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  contactsTable,
  activitiesTable,
  taskInstancesTable,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";

// ---- helpers ----

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

// ---- per-org trigger scans ----

async function scanLicenseExpiring(orgId: string): Promise<number> {
  const horizon = daysFromNow(90);
  const now = new Date();

  const rows = await db
    .select({
      licenseId: stateLicensesTable.id,
      agentId: stateLicensesTable.agentId,
      expiryDate: stateLicensesTable.expiryDate,
      stateCode: stateLicensesTable.stateCode,
    })
    .from(stateLicensesTable)
    .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
    .where(
      and(
        eq(agentsTable.orgId, orgId),
        isNotNull(stateLicensesTable.expiryDate),
        gte(stateLicensesTable.expiryDate, now),
        lte(stateLicensesTable.expiryDate, horizon),
        inArray(stateLicensesTable.status, ["active", "pending"]),
      ),
    );

  for (const row of rows) {
    const daysUntilExpiry = Math.ceil(
      (row.expiryDate!.getTime() - now.getTime()) / 86_400_000,
    );
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId,
      trigger: "license_expires",
      resourceType: "license",
      resourceId: row.licenseId,
      context: {
        agentId: row.agentId,
        stateCode: row.stateCode,
        expiryDate: row.expiryDate!.toISOString(),
        daysUntilExpiry,
      },
    });
  }
  return rows.length;
}

async function scanCertExpiring(orgId: string): Promise<number> {
  const horizon = daysFromNow(90);
  const now = new Date();

  const rows = await db
    .select({
      certId: carrierCertificationsTable.id,
      agentId: carrierCertificationsTable.agentId,
      carrierId: carrierCertificationsTable.carrierId,
      expiryDate: carrierCertificationsTable.expiryDate,
    })
    .from(carrierCertificationsTable)
    .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
    .where(
      and(
        eq(agentsTable.orgId, orgId),
        isNotNull(carrierCertificationsTable.expiryDate),
        gte(carrierCertificationsTable.expiryDate, now),
        lte(carrierCertificationsTable.expiryDate, horizon),
      ),
    );

  for (const row of rows) {
    const daysUntilExpiry = Math.ceil(
      (row.expiryDate!.getTime() - now.getTime()) / 86_400_000,
    );
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId,
      trigger: "certification_expiring",
      resourceType: "certification",
      resourceId: row.certId,
      context: {
        agentId: row.agentId,
        carrierId: row.carrierId,
        expiryDate: row.expiryDate!.toISOString(),
        daysUntilExpiry,
      },
    });
  }
  return rows.length;
}

async function scanAhipDeadlines(orgId: string): Promise<number> {
  const now = new Date();
  const currentYear = now.getFullYear();
  // AHIP must be completed before October 1 of the cert year.
  const deadline = new Date(`${currentYear}-10-01T00:00:00Z`);
  const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);

  // Only scan within 90 days before the deadline
  if (daysUntilDeadline < 0 || daysUntilDeadline > 90) return 0;

  // Existing in-flight records that aren't yet passed/completed.
  const inflight = await db
    .select({
      ahipId: ahipRecordsTable.id,
      agentId: ahipRecordsTable.agentId,
      status: ahipRecordsTable.status,
    })
    .from(ahipRecordsTable)
    .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
    .where(
      and(
        eq(agentsTable.orgId, orgId),
        eq(ahipRecordsTable.certificationYear, currentYear),
        inArray(ahipRecordsTable.status, ["not_started", "in_progress"]),
      ),
    );

  for (const row of inflight) {
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId,
      trigger: "ahip_deadline",
      resourceType: "ahip",
      resourceId: row.ahipId,
      context: {
        agentId: row.agentId,
        certificationYear: currentYear,
        daysUntilDeadline,
        deadlineDate: deadline.toISOString(),
        currentStatus: row.status,
      },
    });
  }

  // Active agents with no AHIP record at all for the current year — these
  // are also "incomplete AHIP" and need to fire the same trigger so that
  // managers can be notified before the deadline. We key the trigger on the
  // agentId since there's no ahip record id to point at yet.
  const missing = await db
    .select({ agentId: agentsTable.id })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.orgId, orgId),
        inArray(agentsTable.status, ["onboarding", "active"]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${ahipRecordsTable}
          WHERE ${ahipRecordsTable.agentId} = ${agentsTable.id}
            AND ${ahipRecordsTable.certificationYear} = ${currentYear}
        )`,
      ),
    );

  for (const row of missing) {
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId,
      trigger: "ahip_deadline",
      resourceType: "agent",
      resourceId: row.agentId,
      context: {
        agentId: row.agentId,
        certificationYear: currentYear,
        daysUntilDeadline,
        deadlineDate: deadline.toISOString(),
        currentStatus: "missing",
      },
    });
  }

  return inflight.length + missing.length;
}

async function scanContactNoActivity(orgId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);

  // Contacts that have no activity logged after the 30-day cutoff
  const rows = await db
    .select({ contactId: contactsTable.id, status: contactsTable.status })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.orgId, orgId),
        inArray(contactsTable.status, ["prospect", "enrolled", "retained"]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${activitiesTable}
          WHERE ${activitiesTable.contactId} = ${contactsTable.id}
            AND ${activitiesTable.createdAt} >= ${cutoff}
        )`,
      ),
    );

  for (const row of rows) {
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId,
      trigger: "contact_no_activity",
      resourceType: "contact",
      resourceId: row.contactId,
      context: {
        contactId: row.contactId,
        contactStatus: row.status,
        daysSinceActivity: 30,
      },
    });
  }
  return rows.length;
}

async function scanTaskOverdue(orgId: string): Promise<number> {
  const now = new Date();

  const rows = await db
    .select({
      taskId: taskInstancesTable.id,
      agentId: taskInstancesTable.agentId,
      contactId: taskInstancesTable.contactId,
      dueDate: taskInstancesTable.dueDate,
      title: taskInstancesTable.title,
    })
    .from(taskInstancesTable)
    .where(
      and(
        eq(taskInstancesTable.orgId, orgId),
        inArray(taskInstancesTable.status, ["open", "in_progress"]),
        isNotNull(taskInstancesTable.dueDate),
        lt(taskInstancesTable.dueDate, now),
      ),
    );

  for (const row of rows) {
    const daysOverdue = Math.floor(
      (now.getTime() - row.dueDate!.getTime()) / 86_400_000,
    );
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId,
      trigger: "task_overdue",
      resourceType: "task",
      resourceId: row.taskId,
      context: {
        agentId: row.agentId ?? null,
        contactId: row.contactId ?? null,
        daysOverdue,
        taskTitle: row.title,
      },
    });
  }
  return rows.length;
}

async function scanScheduled(orgId: string): Promise<void> {
  await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
    orgId,
    trigger: "scheduled",
    resourceType: "org",
    resourceId: orgId,
    context: { sweepDate: new Date().toISOString() },
  });
}

/**
 * Fire `enrollment_period_opens` once on the first day of AEP (Oct 15) and
 * OEP (Jan 1) so that rules keyed to that trigger execute.
 */
async function scanEnrollmentPeriodOpens(orgId: string): Promise<number> {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-based
  const day = now.getDate();

  const isAepOpen = month === 10 && day === 15; // Annual Enrollment Period
  const isOepOpen = month === 1 && day === 1;   // Open Enrollment Period

  if (!isAepOpen && !isOepOpen) return 0;

  const periodType = isAepOpen ? "AEP" : "OEP";

  await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
    orgId,
    trigger: "enrollment_period_opens",
    resourceType: "org",
    resourceId: orgId,
    context: {
      periodType,
      sweepDate: now.toISOString(),
    },
  });

  return 1;
}

// ---- main worker ----

export async function dailyAutomationSweepWorker(): Promise<void> {
  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable);

  logger.info({ orgCount: orgs.length }, "Daily automation sweep started");

  let totalEnqueued = 0;

  for (const org of orgs) {
    try {
      const [licenses, certs, ahip, inactive, overdue, enrollment] = await Promise.all([
        scanLicenseExpiring(org.id),
        scanCertExpiring(org.id),
        scanAhipDeadlines(org.id),
        scanContactNoActivity(org.id),
        scanTaskOverdue(org.id),
        scanEnrollmentPeriodOpens(org.id),
      ]);
      await scanScheduled(org.id);

      const orgTotal = licenses + certs + ahip + inactive + overdue + enrollment + 1;
      totalEnqueued += orgTotal;

      logger.info(
        { orgId: org.id, licenses, certs, ahip, inactive, overdue, enrollment },
        "Automation sweep completed for org",
      );
    } catch (err) {
      logger.error({ err, orgId: org.id }, "Automation sweep failed for org — skipping");
    }
  }

  logger.info({ totalEnqueued }, "Daily automation sweep complete");
}
