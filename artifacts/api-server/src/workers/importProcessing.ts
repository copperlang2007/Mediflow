/**
 * Import Processing Workers
 *
 * pg-boss workers for durable, restart-safe data migration imports.
 * Each worker reads raw row data from importJobsTable.options (stored at enqueue
 * time by the import route) and delegates to the shared processing function.
 *
 * Job names: import-monday | import-ghl | import-csv-contacts
 */

import { eq, sql } from "drizzle-orm";
import { db, importJobsTable } from "@workspace/db";
import { logger } from "../lib/logger";

type ImportJobPayload = { jobId: string };

export async function importMondayWorker(payload: ImportJobPayload): Promise<void> {
  const [job] = await db
    .select()
    .from(importJobsTable)
    .where(eq(importJobsTable.id, payload.jobId))
    .limit(1);

  if (!job) {
    logger.warn({ jobId: payload.jobId }, "import-monday: job not found");
    return;
  }

  const opts = job.options as { rows?: Record<string, string>[]; mapping?: Record<string, string> } | null;
  if (!opts?.rows?.length) {
    logger.warn({ jobId: payload.jobId }, "import-monday: no rows in job options");
    await db.update(importJobsTable).set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` }).where(eq(importJobsTable.id, payload.jobId));
    return;
  }

  // Dynamic import resolves circular dep at runtime (imports.ts → lib/jobs.ts → here → imports.ts)
  const { processMondayImport } = await import("../routes/imports");
  await processMondayImport(payload.jobId, job.orgId, opts.rows, opts.mapping ?? {});
}

export async function importGhlWorker(payload: ImportJobPayload): Promise<void> {
  const [job] = await db
    .select()
    .from(importJobsTable)
    .where(eq(importJobsTable.id, payload.jobId))
    .limit(1);

  if (!job) {
    logger.warn({ jobId: payload.jobId }, "import-ghl: job not found");
    return;
  }

  const opts = job.options as {
    rows?: Record<string, string>[];
    mapping?: Record<string, string>;
    duplicateAction?: string;
  } | null;

  if (!opts?.rows?.length) {
    logger.warn({ jobId: payload.jobId }, "import-ghl: no rows in job options");
    await db.update(importJobsTable).set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` }).where(eq(importJobsTable.id, payload.jobId));
    return;
  }

  const { processGhlImport } = await import("../routes/imports");
  await processGhlImport(payload.jobId, job.orgId, opts.rows, opts.mapping ?? {}, opts.duplicateAction ?? "skip");
}

export async function importCsvContactsWorker(payload: ImportJobPayload): Promise<void> {
  const [job] = await db
    .select()
    .from(importJobsTable)
    .where(eq(importJobsTable.id, payload.jobId))
    .limit(1);

  if (!job) {
    logger.warn({ jobId: payload.jobId }, "import-csv-contacts: job not found");
    return;
  }

  // A redelivered job that already finished has had its rows purged; leave it be.
  if (job.status === "completed") return;

  const opts = job.options as {
    rows?: Record<string, string>[];
    mapping?: Record<string, string>;
    duplicateAction?: string;
  } | null;
  if (!opts?.rows?.length) {
    logger.warn({ jobId: payload.jobId }, "import-csv-contacts: no rows in job options");
    await db.update(importJobsTable).set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` }).where(eq(importJobsTable.id, payload.jobId));
    return;
  }

  const { processCsvContactImport } = await import("../routes/imports");
  const { parseDuplicateAction } = await import("../lib/contactImport");
  await processCsvContactImport(payload.jobId, job.orgId, opts.rows, opts.mapping ?? {}, parseDuplicateAction(opts.duplicateAction));
}
