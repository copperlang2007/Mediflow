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
import { randomUUID } from "crypto";
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
  automationSweepLogTable,
} from "@workspace/db";
import { enqueue, JOB_NAMES, type RunAutomationRulesPayload } from "../lib/jobs";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

// ---- helpers ----

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/**
 * Calendar date (UTC) the sweep is running, e.g. "2026-05-15". Used as
 * the stable per-run component of the sweep idempotency key: a pg-boss
 * retry on the same day collapses onto the existing claim, while the
 * next day's run produces a distinct key and re-fires as intended.
 */
function sweepRunDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Replay-guarded enqueue. Claims `(orgId, sweepType, resourceId,
 * runDate)` in `automation_sweep_log` via INSERT ... ON CONFLICT DO
 * NOTHING and only enqueues the `run-automation-rules` job when the
 * insert actually claimed the row. On a sweep replay, records already
 * processed today conflict and are skipped — preventing the
 * non-idempotent downstream worker from re-firing duplicate alerts,
 * notifications and auto-created tasks.
 *
 * Failure handling: if the claim succeeds but `enqueue` throws, the
 * claim is rolled back (best-effort delete) so the record is retried on
 * the next sweep replay rather than being silently skipped. If the
 * rollback delete itself fails the worst case is that the record waits
 * for the following day's sweep — acceptable, and logged.
 */
async function claimAndEnqueue(
  orgId: string,
  sweepType: string,
  resourceId: string,
  runDate: string,
  payload: RunAutomationRulesPayload,
): Promise<boolean> {
  const claimed = await db
    .insert(automationSweepLogTable)
    .values({
      id: randomUUID(),
      orgId,
      sweepType,
      resourceId,
      sweepRunDate: runDate,
    })
    .onConflictDoNothing({
      target: [
        automationSweepLogTable.orgId,
        automationSweepLogTable.sweepType,
        automationSweepLogTable.resourceId,
        automationSweepLogTable.sweepRunDate,
      ],
    })
    .returning({ id: automationSweepLogTable.id });

  // Conflict: already claimed (and enqueued) by an earlier run today.
  if (claimed.length === 0) return false;

  try {
    // `enqueue` is generic over `Record<string, unknown>`; the payload
    // interface is structurally compatible but TS won't widen a named
    // interface to an index signature, so spread it into a plain object.
    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, { ...payload });
    return true;
  } catch (err) {
    // Roll the claim back so the next sweep replay retries this record.
    try {
      await db
        .delete(automationSweepLogTable)
        .where(eq(automationSweepLogTable.id, claimed[0]!.id));
    } catch (rollbackErr) {
      logger.error(
        { rollbackErr, orgId, sweepType, resourceId },
        "Sweep claim rollback failed — record will retry on next day's sweep",
      );
    }
    throw err;
  }
}

// ---- per-org trigger scans ----

async function scanLicenseExpiring(orgId: string, runDate: string): Promise<number> {
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

  let enqueued = 0;
  for (const row of rows) {
    const daysUntilExpiry = Math.ceil(
      (row.expiryDate!.getTime() - now.getTime()) / 86_400_000,
    );
    const fired = await claimAndEnqueue(orgId, "license_expiring", row.licenseId, runDate, {
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
    if (fired) enqueued++;
  }
  return enqueued;
}

async function scanCertExpiring(orgId: string, runDate: string): Promise<number> {
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

  let enqueued = 0;
  for (const row of rows) {
    const daysUntilExpiry = Math.ceil(
      (row.expiryDate!.getTime() - now.getTime()) / 86_400_000,
    );
    const fired = await claimAndEnqueue(orgId, "cert_expiring", row.certId, runDate, {
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
    if (fired) enqueued++;
  }
  return enqueued;
}

async function scanAhipDeadlines(orgId: string, runDate: string): Promise<number> {
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

  let enqueued = 0;
  for (const row of inflight) {
    const fired = await claimAndEnqueue(orgId, "ahip_deadline", row.ahipId, runDate, {
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
    if (fired) enqueued++;
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
    // Distinct sweep_type from the in-flight path: the missing-AHIP path
    // keys on agentId, the in-flight path on ahipId, and those id spaces
    // could in principle collide — separate sweep_type values keep the
    // two claims independent.
    const fired = await claimAndEnqueue(orgId, "ahip_missing", row.agentId, runDate, {
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
    if (fired) enqueued++;
  }

  return enqueued;
}

async function scanContactNoActivity(orgId: string, runDate: string): Promise<number> {
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

  let enqueued = 0;
  for (const row of rows) {
    const fired = await claimAndEnqueue(orgId, "contact_no_activity", row.contactId, runDate, {
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
    if (fired) enqueued++;
  }
  return enqueued;
}

async function scanTaskOverdue(orgId: string, runDate: string): Promise<number> {
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

  let enqueued = 0;
  for (const row of rows) {
    const daysOverdue = Math.floor(
      (now.getTime() - row.dueDate!.getTime()) / 86_400_000,
    );
    const fired = await claimAndEnqueue(orgId, "task_overdue", row.taskId, runDate, {
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
    if (fired) enqueued++;
  }
  return enqueued;
}

async function scanScheduled(orgId: string, runDate: string): Promise<number> {
  const fired = await claimAndEnqueue(orgId, "scheduled", orgId, runDate, {
    orgId,
    trigger: "scheduled",
    resourceType: "org",
    resourceId: orgId,
    context: { sweepDate: new Date().toISOString() },
  });
  return fired ? 1 : 0;
}

/**
 * Fire `enrollment_period_opens` once on the first day of AEP (Oct 15) and
 * OEP (Jan 1) so that rules keyed to that trigger execute.
 */
async function scanEnrollmentPeriodOpens(orgId: string, runDate: string): Promise<number> {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-based
  const day = now.getDate();

  const isAepOpen = month === 10 && day === 15; // Annual Enrollment Period
  const isOepOpen = month === 1 && day === 1;   // Open Enrollment Period

  if (!isAepOpen && !isOepOpen) return 0;

  const periodType = isAepOpen ? "AEP" : "OEP";

  const fired = await claimAndEnqueue(
    orgId,
    `enrollment_period_opens:${periodType}`,
    orgId,
    runDate,
    {
      orgId,
      trigger: "enrollment_period_opens",
      resourceType: "org",
      resourceId: orgId,
      context: {
        periodType,
        sweepDate: now.toISOString(),
      },
    },
  );

  return fired ? 1 : 0;
}

// ---- main worker ----

export async function dailyAutomationSweepWorker(): Promise<void> {
  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable);

  // Stable per-run key component: a pg-boss retry of the sweep on the
  // same UTC day reuses this date, so already-claimed records collapse
  // to no-ops; next day's run is a distinct key and re-fires.
  const runDate = sweepRunDate();

  logger.info({ orgCount: orgs.length, runDate }, "Daily automation sweep started");

  let totalEnqueued = 0;

  for (const org of orgs) {
    try {
      const [licenses, certs, ahip, inactive, overdue, enrollment] = await Promise.all([
        scanLicenseExpiring(org.id, runDate),
        scanCertExpiring(org.id, runDate),
        scanAhipDeadlines(org.id, runDate),
        scanContactNoActivity(org.id, runDate),
        scanTaskOverdue(org.id, runDate),
        scanEnrollmentPeriodOpens(org.id, runDate),
      ]);
      const scheduled = await scanScheduled(org.id, runDate);

      // Each scan returns the count of records it actually enqueued
      // (claimed), so on a replay these collapse toward zero rather than
      // double-counting.
      const orgTotal =
        licenses + certs + ahip + inactive + overdue + enrollment + scheduled;
      totalEnqueued += orgTotal;

      logger.info(
        { orgId: org.id, licenses, certs, ahip, inactive, overdue, enrollment, scheduled },
        "Automation sweep completed for org",
      );
    } catch (err) {
      logger.error({ err, orgId: org.id }, "Automation sweep failed for org — skipping");
      captureWorkerError(err, { worker: "weeklyAutomationSweep", orgId: org.id });
    }
  }

  logger.info({ totalEnqueued }, "Daily automation sweep complete");
}
