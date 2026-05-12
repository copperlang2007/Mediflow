/**
 * Export-Volume Anomaly Detector (daily cron).
 *
 * For each org, this worker:
 *   1. Pulls `data_export_log` rows for the last 30 days.
 *   2. Groups them by UTC day, then computes the mean + population stddev of
 *      per-day export counts across the rolling 30-day window.
 *   3. Counts exports in the last 24h ("today").
 *   4. If today's count exceeds `mean + 3*stddev` AND is at least 5, a
 *      `breach_notifications` row is inserted with severity=medium so that an
 *      analyst can investigate possible exfiltration / a runaway script.
 *
 * Idempotent per (orgId, day): the worker skips an org when a row already
 * exists for `detected_by_system = 'export_anomaly_alert'` with a
 * `detected_at >= today UTC midnight`. Re-running on the same day never
 * multiplies rows.
 *
 * Closes the last `partial` control on `/admin/baa-checklist`
 * (`export_anomaly_alerting`). Runs daily at 02:15 UTC via pg-boss.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  breachNotificationsTable,
  dataExportLogTable,
  organizationsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const SIGMA_MULTIPLIER = 3;
const MIN_TODAY_COUNT = 5;

interface OrgStats {
  todayCount: number;
  mean: number;
  stddev: number;
}

/**
 * Compute mean + population stddev of per-day export counts in the 30-day
 * window, and count rows in the trailing 24h. We bucket on the calendar UTC
 * day so a single export at 23:59 doesn't get smeared across two days.
 *
 * Population (not sample) stddev is the right choice here: we have the full
 * 30-day window, not a sample. Using `n-1` would penalize small windows for
 * no statistical reason.
 */
async function computeOrgStats(orgId: string, now: Date): Promise<OrgStats> {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const todayStart = new Date(now.getTime() - DAY_MS);

  const rows = await db
    .select({ createdAt: dataExportLogTable.createdAt })
    .from(dataExportLogTable)
    .where(
      and(
        eq(dataExportLogTable.orgId, orgId),
        gte(dataExportLogTable.createdAt, windowStart),
      ),
    );

  if (rows.length === 0) {
    return { todayCount: 0, mean: 0, stddev: 0 };
  }

  // Bucket rows by UTC calendar day → count per day.
  const byDay = new Map<string, number>();
  let todayCount = 0;
  for (const r of rows) {
    const ts = r.createdAt!;
    const key = ts.toISOString().slice(0, 10); // YYYY-MM-DD UTC
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
    if (ts.getTime() >= todayStart.getTime()) todayCount++;
  }

  // Densify across the whole 30-day window so silent days contribute 0 to
  // the mean (otherwise a sleepy org with one busy day looks normal).
  const counts: number[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    counts.push(byDay.get(key) ?? 0);
  }

  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance =
    counts.reduce((acc, c) => acc + (c - mean) ** 2, 0) / counts.length;
  const stddev = Math.sqrt(variance);

  return { todayCount, mean, stddev };
}

async function hasTodayAlert(orgId: string, now: Date): Promise<boolean> {
  // Anchor "today" on UTC midnight so the same calendar day never produces
  // duplicate alerts regardless of when the cron fires within the day.
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [existing] = await db
    .select({ id: breachNotificationsTable.id })
    .from(breachNotificationsTable)
    .where(
      and(
        eq(breachNotificationsTable.orgId, orgId),
        eq(breachNotificationsTable.detectedBySystem, "export_anomaly_alert"),
        gte(breachNotificationsTable.detectedAt, utcMidnight),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

export async function exportAnomalyCheckWorker(): Promise<void> {
  const now = new Date();

  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable);

  logger.info({ orgCount: orgs.length }, "Export anomaly check started");

  let alertsInserted = 0;

  for (const org of orgs) {
    try {
      const { todayCount, mean, stddev } = await computeOrgStats(org.id, now);

      const threshold = mean + SIGMA_MULTIPLIER * stddev;
      const isAnomaly = todayCount > threshold && todayCount >= MIN_TODAY_COUNT;

      if (!isAnomaly) continue;

      // Idempotent per (org, UTC day).
      if (await hasTodayAlert(org.id, now)) {
        logger.info(
          { orgId: org.id, todayCount, mean, stddev },
          "Export anomaly already recorded today — skipping",
        );
        continue;
      }

      const description = `Export volume anomaly: ${todayCount} exports today vs 30-day mean ${mean.toFixed(1)} (σ=${stddev.toFixed(1)}). Possible exfiltration or runaway script.`;

      await db.insert(breachNotificationsTable).values({
        id: randomUUID(),
        orgId: org.id,
        detectedBySystem: "export_anomaly_alert",
        affectedRecordType: "export_volume",
        affectedRecordCount: todayCount,
        description,
        severity: "medium",
        status: "open",
        notificationRequired: false,
      });

      alertsInserted++;
      logger.warn(
        { orgId: org.id, todayCount, mean, stddev, threshold },
        "Export volume anomaly detected — breach_notifications row inserted",
      );
    } catch (err) {
      logger.error(
        { err, orgId: org.id },
        "Export anomaly check failed for org — skipping",
      );
      captureWorkerError(err, { worker: "exportAnomalyCheck", orgId: org.id });
    }
  }

  logger.info({ alertsInserted }, "Export anomaly check complete");
}
