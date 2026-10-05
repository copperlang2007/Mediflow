/**
 * Call recordings → transcript → score (phase 2b).
 *
 * The browser uploads the audio straight to the private bucket with a signed
 * URL (Cloud Run caps request bodies at 32 MB, too small for a long call), then
 * confirms. A background job moves the row along:
 *
 *   queued        → start Google Speech-to-Text on the gs:// object
 *   transcribing  → poll the operation; when done, turn the result into the
 *                   utterance JSON parse.ts reads and score it through the
 *                   same ingestTranscript() every text transcript uses
 *   scored        → linked to its call_transcripts row (an already-scored
 *                   call links to the existing transcript; that is not an error)
 *   failed        → a plain reason, safe to show (never transcript text)
 *
 * Each step is idempotent: it re-reads the row and claims each transition with
 * a conditional update BEFORE calling Google, so a retried or duplicated job
 * never starts a second transcription or scores the same call twice
 * (ingestTranscript also dedupes by content). `checked_at` records each look;
 * the sweeper (workers/recordingsSweep.ts) re-queues rows whose job chain died.
 */
import { and, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db, callRecordingsTable, callScoreClaimsTable, callScoresTable, type CallRecordingLayout, type CallTranscriptSource } from "@workspace/db";
import { logger } from "../logger";
import { open } from "./seal";
import { DEFAULT_RUBRIC_ID, getRubric } from "./rubrics";
import { ingestTranscript, rescoreTranscript, resolveRubric } from "./ingest";
import type { Rubric } from "./types";
import { cancelTranscription, gsUri, pollTranscription, resultsToTurns, safeReason, speechSetup, startTranscription } from "./speech";

/** How long a transcription may run before it is given up on. */
export const TRANSCRIBE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Seconds between checks on a running transcription. */
export const POLL_INTERVAL_SEC = 30;
const MAX_START_ATTEMPTS = 3;

export interface RecordingDetails {
  filename: string | null;
  phone: string | null;
  externalRef: string | null;
  uploaderRole: string;
}

export type StepOutcome = "poll" | "retry_start" | "finished";

/** Only a recording still in flight can fail: a stale job never overwrites one another job scored. */
async function fail(id: string, reason: string): Promise<StepOutcome> {
  await db.update(callRecordingsTable)
    .set({ status: "failed", error: reason, updatedAt: new Date() })
    .where(and(eq(callRecordingsTable.id, id), inArray(callRecordingsTable.status, ["queued", "transcribing"])));
  return "finished";
}

/**
 * A claim older than this belongs to a job that died mid-score and is taken
 * over. Scoring is bounded (AI review 90 s, each statement 30 s), so a live
 * job is far inside this; one that stalls anyway cannot save its score after
 * a takeover (rescoreTranscript's stillOwned check).
 */
const RESCORE_CLAIM_STALE_MS = 15 * 60 * 1000;

/** Claim the right to add a score to a call; returns the claim's timestamp (its token) or null if another job holds it. */
async function claimRescore(transcriptId: string, now: Date): Promise<Date | null> {
  const claimed = await db
    .insert(callScoreClaimsTable)
    .values({ transcriptId, claimedAt: now })
    .onConflictDoUpdate({
      target: callScoreClaimsTable.transcriptId,
      set: { claimedAt: now },
      where: lt(callScoreClaimsTable.claimedAt, new Date(now.getTime() - RESCORE_CLAIM_STALE_MS)),
    })
    .returning({ claimedAt: callScoreClaimsTable.claimedAt });
  return claimed.length ? now : null;
}

/** A start that was claimed but never recorded its operation (a crash mid-start) is retried after this. */
const START_STALL_MS = 10 * 60 * 1000;

export async function processRecording(recordingId: string, deps: { privateObjectDir?: string } = {}): Promise<StepOutcome> {
  const [row] = await db.select().from(callRecordingsTable).where(eq(callRecordingsTable.id, recordingId)).limit(1);
  if (!row || row.status === "scored" || row.status === "failed" || row.status === "uploading") return "finished";

  const setup = speechSetup();
  if (!setup.ready) return fail(row.id, setup.message);
  const layout = row.layout as CallRecordingLayout;
  const now = new Date();

  if (row.status === "queued") {
    // Claim first, then call Google: of two jobs racing on one recording only
    // the one that wins this update starts (and pays for) a transcription.
    const attempts = row.attempts + 1;
    const claimed = await db.update(callRecordingsTable)
      .set({ status: "transcribing", operationName: null, attempts, error: null, checkedAt: now, updatedAt: now })
      .where(and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "queued")))
      .returning({ id: callRecordingsTable.id });
    if (!claimed.length) return "finished";
    const dir = deps.privateObjectDir ?? process.env.PRIVATE_OBJECT_DIR ?? "";
    try {
      const operationName = await startTranscription(gsUri(dir, row.objectKey), layout);
      await db.update(callRecordingsTable)
        .set({ operationName, checkedAt: new Date() })
        .where(and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "transcribing")));
      return "poll";
    } catch (err) {
      logger.warn({ reason: safeReason((err as Error).message), recordingId: row.id }, "Speech-to-Text: could not start transcription");
      if (attempts >= MAX_START_ATTEMPTS) {
        return fail(row.id, "Speech-to-Text could not start transcribing this recording after several tries. Upload it again later; if it keeps failing, ask the administrator to check the Speech-to-Text setup.");
      }
      await db.update(callRecordingsTable)
        .set({ status: "queued", updatedAt: new Date() })
        .where(and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "transcribing")));
      return "retry_start";
    }
  }

  // transcribing
  if (!row.operationName) {
    // Another job is starting it right now, or that job died before saving the operation.
    if (now.getTime() - row.updatedAt.getTime() < START_STALL_MS) return "poll";
    if (row.attempts >= MAX_START_ATTEMPTS) {
      return fail(row.id, "Speech-to-Text could not start transcribing this recording after several tries. Upload it again later; if it keeps failing, ask the administrator to check the Speech-to-Text setup.");
    }
    // The interrupted start still counts as an attempt, so a start that keeps
    // crashing gives up after MAX_START_ATTEMPTS instead of looping forever.
    await db.update(callRecordingsTable)
      .set({ status: "queued", updatedAt: now })
      .where(and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "transcribing"), isNull(callRecordingsTable.operationName)));
    return "retry_start";
  }
  await db.update(callRecordingsTable).set({ checkedAt: now }).where(eq(callRecordingsTable.id, row.id));
  let poll;
  try {
    poll = await pollTranscription(row.operationName);
  } catch (err) {
    logger.warn({ reason: safeReason((err as Error).message), recordingId: row.id }, "Speech-to-Text: poll failed; will retry");
    poll = { state: "running" as const };
  }
  if (poll.state === "running") {
    if (Date.now() - row.updatedAt.getTime() > TRANSCRIBE_TIMEOUT_MS) {
      const cancelled = await cancelTranscription(row.operationName);
      if (!cancelled) logger.warn({ recordingId: row.id }, "Speech-to-Text: could not cancel a timed-out transcription");
      return fail(
        row.id,
        cancelled
          ? "Transcription took too long and was stopped. Try again, or split the recording."
          : "Transcription took too long and was abandoned. Try again, or split the recording.",
      );
    }
    return "poll";
  }
  if (poll.state === "failed") return fail(row.id, poll.reason);

  const turns = resultsToTurns(poll.results, layout);
  if (!turns.length) return fail(row.id, "No speech was found in the recording.");
  if (!row.createdBy) return fail(row.id, "The person who uploaded this recording no longer has an account. Upload it again.");

  const details = open<RecordingDetails>(row.detailsEncrypted) ?? { filename: null, phone: null, externalRef: null, uploaderRole: "compliance_manager" };
  const rubric = resolveRubric(row.rubricId ?? undefined, getRubric(DEFAULT_RUBRIC_ID) as Rubric) ?? (getRubric(DEFAULT_RUBRIC_ID) as Rubric);
  const result = await ingestTranscript({
    orgId: row.orgId,
    userId: row.createdBy,
    userRole: details.uploaderRole,
    content: JSON.stringify(turns),
    filename: details.filename,
    format: "json",
    rubric,
    // The uploader's source (e.g. an ENROLLHERE download) is kept; a plain upload is a "recording".
    source: row.source === "upload" ? "recording" : (row.source as CallTranscriptSource),
    externalRef: details.externalRef,
    callDate: row.callDate,
    phone: details.phone,
    contactId: row.contactId,
    callSessionId: row.callSessionId,
    agentId: row.agentId,
    aiMode: row.aiMode === "off" ? "off" : "auto",
  });

  if (result.kind === "error") return fail(row.id, result.message);
  const transcriptId = result.kind === "ok" ? result.summary.transcriptId : result.transcriptId;
  if (result.kind === "duplicate") {
    // Same speech as an earlier call. The call shows its newest score, so when
    // that is under another checklist, score it under the one chosen for this
    // upload (history is kept). When the newest score already uses this
    // checklist nothing is re-run. Only one recording job at a time may add a
    // score to a call: a duplicate racing another waits and re-checks. (A
    // person's explicit "Rescore" in the app is not blocked by this claim.)
    const claimedAt = await claimRescore(transcriptId, now);
    if (!claimedAt) return "poll";
    try {
      const [latest] = await db
        .select({ rubricId: callScoresTable.rubricId })
        .from(callScoresTable)
        .where(and(eq(callScoresTable.orgId, row.orgId), eq(callScoresTable.transcriptId, transcriptId)))
        .orderBy(desc(callScoresTable.createdAt), desc(callScoresTable.id))
        .limit(1);
      if (latest?.rubricId !== rubric.id) {
        const rescored = await rescoreTranscript({
          orgId: row.orgId,
          userId: row.createdBy,
          userRole: details.uploaderRole,
          transcriptId,
          rubric,
          aiMode: row.aiMode === "off" ? "off" : "auto",
          stillOwned: async (tx) =>
            (
              await tx
                .select({ transcriptId: callScoreClaimsTable.transcriptId })
                .from(callScoreClaimsTable)
                .where(and(eq(callScoreClaimsTable.transcriptId, transcriptId), eq(callScoreClaimsTable.claimedAt, claimedAt)))
                .for("update")
            ).length > 0,
        });
        if (rescored.kind === "error") return fail(row.id, rescored.message);
        // Lost the claim mid-score: nothing was saved. Check again later instead of finishing without this checklist's score.
        if (rescored.kind === "duplicate") return "poll";
      }
    } finally {
      // Best effort: if this fails the claim goes stale and is taken over; the recording still finishes.
      try {
        await db.delete(callScoreClaimsTable)
          .where(and(eq(callScoreClaimsTable.transcriptId, transcriptId), eq(callScoreClaimsTable.claimedAt, claimedAt)));
      } catch (err) {
        logger.warn({ err: (err as Error).message, recordingId: row.id }, "Call recording: could not release the score claim; it will be taken over when stale");
      }
    }
  }
  await db.update(callRecordingsTable)
    .set({
      status: "scored",
      transcriptId,
      durationSeconds: poll.durationSeconds,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(callRecordingsTable.id, row.id));
  return "finished";
}

/** A queued or transcribing recording nobody has looked at for this long has lost its job chain. */
export const STALLED_AFTER_MS = 10 * 60 * 1000;
/** Signed upload URLs last 15 minutes; an upload never confirmed after this is given up on. */
export const UPLOAD_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long a signed upload URL stays valid. */
export const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

/**
 * When audio that will not be transcribed can be deleted for good: after its
 * upload link has expired (plus a minute of clock slack), so nobody can PUT it
 * back. Deleting earlier is fine but must be repeated at this time.
 */
export function purgeTime(createdAt: Date, now: Date = new Date()): Date {
  const expired = new Date(createdAt.getTime() + UPLOAD_URL_TTL_MS + 60_000);
  return expired > now ? expired : now;
}

/** Most audio deletes one sweep attempts; the rest wait for the next run. */
const PURGE_BATCH = 200;
/** After this many failed deletes in a row the failure is logged as an error (retries continue, at most daily). */
export const PURGE_ALERT_AFTER = 5;

/** Wait before retrying a failed delete: 2, 4, 8 … minutes, capped at a day. Audio is never given up on. */
export function purgeBackoffMs(attempts: number): number {
  return Math.min(24 * 60 * 60 * 1000, 2 ** Math.min(attempts, 20) * 60_000);
}

/**
 * Recover recordings whose job chain died (a failed re-enqueue, a lost job,
 * a crash): re-queue the job for stalled queued / transcribing rows, fail
 * uploads that were never confirmed, and delete audio that will not be
 * transcribed. Each stalled row is claimed by bumping `checked_at` first, so
 * overlapping sweeps queue it once. A delete that fails keeps `purge_after`
 * set, pushed back with exponential backoff, and is retried.
 */
export async function sweepStalledRecordings(
  requeue: (recordingId: string) => Promise<boolean>,
  now: Date,
  deleteObject: (objectKey: string) => Promise<void>,
): Promise<{ requeued: number; abandoned: number; purged: number }> {
  const stalledBefore = new Date(now.getTime() - STALLED_AFTER_MS);
  const stalled = await db
    .update(callRecordingsTable)
    .set({ checkedAt: now })
    .where(
      and(
        inArray(callRecordingsTable.status, ["queued", "transcribing"]),
        lt(sql`coalesce(${callRecordingsTable.checkedAt}, ${callRecordingsTable.updatedAt})`, stalledBefore),
      ),
    )
    .returning({ id: callRecordingsTable.id });
  let requeued = 0;
  for (const r of stalled) if (await requeue(r.id)) requeued++;

  // Whatever was uploaded for an unfinished recording is PHI nobody will use: mark it for deletion.
  const abandoned = await db
    .update(callRecordingsTable)
    .set({ status: "failed", error: "The upload was never finished. Upload the recording again.", purgeAfter: now, updatedAt: now })
    .where(
      and(
        eq(callRecordingsTable.status, "uploading"),
        lt(callRecordingsTable.createdAt, new Date(now.getTime() - UPLOAD_ABANDONED_AFTER_MS)),
      ),
    )
    .returning({ id: callRecordingsTable.id });

  const due = await db
    .select({ id: callRecordingsTable.id, objectKey: callRecordingsTable.objectKey, purgeAttempts: callRecordingsTable.purgeAttempts })
    .from(callRecordingsTable)
    .where(and(eq(callRecordingsTable.status, "failed"), lte(callRecordingsTable.purgeAfter, now)))
    .orderBy(callRecordingsTable.purgeAfter)
    .limit(PURGE_BATCH);
  let purged = 0;
  for (const r of due) {
    try {
      await deleteObject(r.objectKey);
    } catch (err) {
      // Back off so stuck deletes do not crowd out new ones; keep retrying.
      const attempts = r.purgeAttempts + 1;
      await db.update(callRecordingsTable)
        .set({ purgeAttempts: attempts, purgeAfter: new Date(now.getTime() + purgeBackoffMs(attempts)) })
        .where(eq(callRecordingsTable.id, r.id));
      const log = { err: (err as Error).message, recordingId: r.id, attempts };
      if (attempts >= PURGE_ALERT_AFTER) logger.error(log, "Call recording sweep: unused audio still cannot be deleted; check bucket access");
      else logger.warn(log, "Call recording sweep: could not delete unused audio; will retry");
      continue;
    }
    await db.update(callRecordingsTable).set({ purgeAfter: null, purgeAttempts: 0 }).where(eq(callRecordingsTable.id, r.id));
    purged++;
  }
  return { requeued, abandoned: abandoned.length, purged };
}
