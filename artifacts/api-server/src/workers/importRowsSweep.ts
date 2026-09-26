/**
 * Hourly sweep of queued import rows.
 *
 * Import jobs carry their parsed rows in `import_jobs.options.rows` until the
 * worker finishes — plaintext PHI (names, DOBs, addresses). Every normal and
 * failure path already drops them, but a worker killed mid-job (OOM, instance
 * preemption) leaves the job `processing` with its rows until the next
 * process start. This bounds that window to hours instead of "until restart".
 *
 *   - finished jobs (completed / failed) still holding rows → rows dropped
 *   - CSV contact jobs `processing` with no worker progress for STALE_MINUTES
 *     → marked failed, rows dropped. A job that has never written a heartbeat
 *     (queued, or started by code from before heartbeats existed) gets the
 *     older, generous LEGACY_STALE_HOURS instead. Other import types (Monday,
 *     GHL) don't heartbeat and aren't touched here.
 *
 * A worker that is still alive keeps its heartbeat fresh, so a long import is
 * never failed out from under it; and its writes only apply while the job is
 * still `processing`, so a job failed here can't flip back to `completed`.
 */
import { and, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { db, importJobsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const STALE_MINUTES = 30;
export const LEGACY_STALE_HOURS = 6;

/** CSV contact jobs whose worker has shown no progress since `cutoff`. */
export function staleProcessingJobs(cutoff: Date): SQL | undefined {
  const legacyCutoff = new Date(cutoff.getTime() + STALE_MINUTES * 60_000 - LEGACY_STALE_HOURS * 3_600_000);
  return and(
    eq(importJobsTable.status, "processing"),
    eq(importJobsTable.importType, "csv_contacts"),
    or(
      and(isNotNull(importJobsTable.heartbeatAt), lt(importJobsTable.heartbeatAt, cutoff)),
      and(isNull(importJobsTable.heartbeatAt), lt(importJobsTable.createdAt, legacyCutoff)),
    ),
  );
}

export async function importRowsSweepWorker(now: Date = new Date()): Promise<{ purged: number; failed: number }> {
  const cutoff = new Date(now.getTime() - STALE_MINUTES * 60_000);
  const hasRows = sql`${importJobsTable.options} ? 'rows'`;

  const stale = await db.update(importJobsTable)
    .set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` })
    .where(staleProcessingJobs(cutoff))
    .returning({ id: importJobsTable.id });

  const finished = await db.update(importJobsTable)
    .set({ options: sql`${importJobsTable.options} - 'rows'` })
    .where(and(ne(importJobsTable.status, "processing"), ne(importJobsTable.status, "pending"), hasRows))
    .returning({ id: importJobsTable.id });

  if (stale.length || finished.length) {
    logger.info({ staleFailed: stale.length, purged: finished.length }, "import-rows-sweep: dropped queued rows");
  }
  return { purged: finished.length + stale.length, failed: stale.length };
}
