/**
 * Statement folder poller.
 *
 *   - Scheduled every 10 min with `{}`: polls every enabled source.
 *   - Enqueued with `{ sourceId }`: one source (continuation after the per-run cap,
 *     or an admin "check now").
 *
 * Safe to overlap or retry: each file is claimed by a unique ledger row before
 * any work, so a file is processed at most once per content checksum. Errors are
 * recorded on the source and never thrown, so the next tick is the retry.
 */
import { randomUUID } from "crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  notificationsTable,
  statementIngestFilesTable,
  statementIngestSourcesTable,
  usersTable,
  type StatementIngestSource,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";
import { broadcastToUsers } from "../lib/sseManager";
import { DriveStatementSource } from "../lib/statementIngest/driveSource";
import { ingestFile, STALE_PROCESSING_MS, type IngestDeps, type IngestOutcome } from "../lib/statementIngest/ingest";
import type { StatementSource } from "../lib/statementIngest/types";

export interface StatementIngestPollPayload {
  sourceId?: string;
}

/** Files handled per source per run; the rest are picked up by a continuation job. */
export const MAX_FILES_PER_RUN = 25;
/** Ids per ledger lookup, keeping the IN list well under the bound-parameter limit. */
const SEEN_LOOKUP_CHUNK = 500;
/** At most one Sentry event per source per hour for a failure that repeats every tick. */
const CAPTURE_COOLDOWN_MS = 60 * 60 * 1000;
const lastCapturedAt = new Map<string, number>();

export interface PollDeps {
  makeSource: (source: StatementIngestSource) => StatementSource;
  /** Overrides for file storage / reconcile (tests); defaults to the real ones. */
  ingest?: IngestDeps;
}

const defaultDeps: PollDeps = {
  makeSource: (s) => new DriveStatementSource(s.folderId),
};

export async function statementIngestPollWorker(
  payload: StatementIngestPollPayload = {},
  deps: PollDeps = defaultDeps,
): Promise<void> {
  const where = payload.sourceId
    ? and(eq(statementIngestSourcesTable.id, payload.sourceId), eq(statementIngestSourcesTable.enabled, true))
    : eq(statementIngestSourcesTable.enabled, true);
  const sources = await db.select().from(statementIngestSourcesTable).where(where);

  for (const source of sources) {
    try {
      const { more, flagged } = await pollSource(source, deps);
      await db
        .update(statementIngestSourcesTable)
        .set({ lastPolledAt: new Date(), lastError: null })
        .where(eq(statementIngestSourcesTable.id, source.id));
      lastCapturedAt.delete(source.id);
      if (flagged > 0) await notifyReviewers(source);
      if (more) {
        const id = await enqueue(JOB_NAMES.STATEMENT_INGEST_POLL, { sourceId: source.id });
        if (!id) logger.error({ sourceId: source.id }, "Statement ingest: could not queue continuation; next tick resumes");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error({ errName: err instanceof Error ? err.name : "Error", sourceId: source.id }, "Statement ingest: poll failed");
      await db
        .update(statementIngestSourcesTable)
        .set({ lastPolledAt: new Date(), lastError: message.slice(0, 500) })
        .where(eq(statementIngestSourcesTable.id, source.id));
      const last = lastCapturedAt.get(source.id) ?? 0;
      if (Date.now() - last > CAPTURE_COOLDOWN_MS) {
        captureWorkerError(err, { worker: "statement-ingest-poll", sourceId: source.id });
        lastCapturedAt.set(source.id, Date.now());
      }
    }
  }
}

async function pollSource(
  source: StatementIngestSource,
  deps: PollDeps,
): Promise<{ more: boolean; flagged: number }> {
  // A file claimed by a run that then died would otherwise stay 'processing' forever.
  // These count as flagged: nothing else would ever tell a reviewer about them.
  const interrupted = await db
    .update(statementIngestFilesTable)
    .set({ status: "failed", reason: "Interrupted before finishing; use Retry to process it again" })
    .where(
      and(
        eq(statementIngestFilesTable.sourceId, source.id),
        eq(statementIngestFilesTable.status, "processing"),
        lt(statementIngestFilesTable.updatedAt, new Date(Date.now() - STALE_PROCESSING_MS)),
      ),
    )
    .returning({ id: statementIngestFilesTable.id });

  const from = deps.makeSource(source);
  const listed = await from.list();

  // Look up only the files this listing contains, not the source's whole history: the ledger
  // grows forever while the folder usually holds a handful of files.
  const seenKeys = new Set<string>();
  for (let i = 0; i < listed.length; i += SEEN_LOOKUP_CHUNK) {
    const ids = listed.slice(i, i + SEEN_LOOKUP_CHUNK).map((f) => f.externalId);
    const seen = await db
      .select({ externalId: statementIngestFilesTable.externalId, checksum: statementIngestFilesTable.checksum })
      .from(statementIngestFilesTable)
      .where(and(eq(statementIngestFilesTable.sourceId, source.id), inArray(statementIngestFilesTable.externalId, ids)));
    for (const r of seen) seenKeys.add(`${r.externalId}|${r.checksum}`);
  }
  const fresh = listed
    .filter((f) => !seenKeys.has(`${f.externalId}|${f.checksum}`))
    // Oldest first, so statements post in the order they were dropped.
    .sort((a, b) => (a.modifiedTime?.getTime() ?? 0) - (b.modifiedTime?.getTime() ?? 0));

  let flagged = interrupted.length;
  for (const file of fresh.slice(0, MAX_FILES_PER_RUN)) {
    const outcome: IngestOutcome = await ingestFile(source, file, from, deps.ingest);
    if (outcome === "needs_review" || outcome === "failed") flagged += 1;
  }
  return { more: fresh.length > MAX_FILES_PER_RUN, flagged };
}

async function notifyReviewers(source: StatementIngestSource): Promise<void> {
  const reviewers = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.orgId, source.orgId), inArray(usersTable.role, ["agency_admin", "compliance_manager"])));
  if (reviewers.length === 0) return;
  // One unread alert per reviewer per source: the table has no unique key to dedup on, and a
  // poll every 10 minutes would otherwise add a row (and an SSE ping) per flagged file per tick.
  const alreadyAlerted = await db
    .select({ userId: notificationsTable.userId })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.orgId, source.orgId),
        eq(notificationsTable.type, "statement_ingest_review"),
        eq(notificationsTable.resourceId, source.id),
        inArray(notificationsTable.userId, reviewers.map((u) => u.id)),
        isNull(notificationsTable.readAt),
      ),
    );
  const skip = new Set(alreadyAlerted.map((r) => r.userId));

  // The alert reports the real backlog, not just this poll's new flags, so a reviewer reading the
  // title always sees the true count of files waiting on them.
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(statementIngestFilesTable)
    .where(
      and(
        eq(statementIngestFilesTable.sourceId, source.id),
        inArray(statementIngestFilesTable.status, ["needs_review", "failed"]),
      ),
    );
  const title = `${open} carrier statement${open === 1 ? "" : "s"} need review`;
  const body = "Automatic statement intake could not finish these files. Open Commissions to review them.";

  // Keep an existing unread alert current instead of leaving its title frozen at the first count.
  if (skip.size > 0) {
    await db
      .update(notificationsTable)
      .set({ title, body })
      .where(
        and(
          eq(notificationsTable.orgId, source.orgId),
          eq(notificationsTable.type, "statement_ingest_review"),
          eq(notificationsTable.resourceId, source.id),
          inArray(notificationsTable.userId, [...skip]),
          isNull(notificationsTable.readAt),
        ),
      );
  }
  const rows = reviewers
    .filter((u) => !skip.has(u.id))
    .map((u) => ({
      id: randomUUID(),
      orgId: source.orgId,
      userId: u.id,
      type: "statement_ingest_review",
      title,
      body,
      priority: "high",
      resourceType: "statement_ingest_source",
      resourceId: source.id,
    }));
  if (rows.length > 0) await db.insert(notificationsTable).values(rows);
  broadcastToUsers(
    reviewers.map((u) => u.id),
    { type: "notification", resourceType: "statement_ingest_source", resourceId: source.id },
  );
}
