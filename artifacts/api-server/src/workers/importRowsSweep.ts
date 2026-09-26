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
 *   - jobs `processing` with no worker progress for STALE_MINUTES (heartbeat,
 *     or creation time if the worker never started) → marked failed, rows dropped
 *
 * A worker that is still alive keeps its heartbeat fresh, so a long import is
 * never failed out from under it; and its writes only apply while the job is
 * still `processing`, so a job failed here can't flip back to `completed`.
 */
import { and, eq, lt, ne, sql, type SQL } from "drizzle-orm";
import { db, importJobsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const STALE_MINUTES = 30;

/** `processing` jobs whose worker has shown no progress since `cutoff`. */
export function staleProcessingJobs(cutoff: Date): SQL | undefined {
  return and(
    eq(importJobsTable.status, "processing"),
    lt(sql`coalesce(${importJobsTable.heartbeatAt}, ${importJobsTable.createdAt})`, cutoff),
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
