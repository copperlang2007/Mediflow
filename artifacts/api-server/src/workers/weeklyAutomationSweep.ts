/**
 * Weekly Automation Sweep Worker.
 *
 * Runs every Monday at 09:00 UTC. Iterates all active organizations and
 * enqueues `run-automation-rules` for the "scheduled" trigger so that
 * time-based automation rules (birthday reminders, plan anniversary
 * notifications, AEP / OEP season alerts, etc.) fire reliably on a
 * weekly cadence even when no real-time event is available.
 */

import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";

export async function weeklyAutomationSweepWorker(): Promise<void> {
  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable);

  logger.info({ orgCount: orgs.length }, "Weekly automation sweep started");

  let enqueued = 0;
  for (const org of orgs) {
    const jobId = await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId: org.id,
      trigger: "scheduled",
      resourceType: "org",
      resourceId: org.id,
      context: { sweepDate: new Date().toISOString() },
    });
    if (jobId) enqueued++;
  }

  logger.info({ enqueued }, "Weekly automation sweep complete");
}
