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
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, callRecordingsTable, type CallRecordingLayout } from "@workspace/db";
import { logger } from "../logger";
import { open } from "./seal";
import { DEFAULT_RUBRIC_ID, getRubric } from "./rubrics";
import { ingestTranscript, resolveRubric } from "./ingest";
import type { Rubric } from "./types";
import { gsUri, pollTranscription, resultsToTurns, safeReason, speechSetup, startTranscription } from "./speech";

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

async function fail(id: string, reason: string): Promise<StepOutcome> {
  await db.update(callRecordingsTable)
    .set({ status: "failed", error: reason, updatedAt: new Date() })
    .where(eq(callRecordingsTable.id, id));
  return "finished";
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
      if (attempts >= MAX_START_ATTEMPTS) return fail(row.id, "Speech-to-Text could not start transcribing this recording. Check the Speech-to-Text setup, then upload it again.");
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
      return fail(row.id, "Transcription took too long and was stopped. Try again, or split the recording.");
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
    source: "recording",
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

/**
 * Recover recordings whose job chain died (a failed re-enqueue, a lost job,
 * a crash): re-queue the job for stalled queued / transcribing rows, and fail
 * uploads that were never confirmed. Each stalled row is claimed by bumping
 * `checked_at` first, so overlapping sweeps queue it once.
 */
export async function sweepStalledRecordings(
  requeue: (recordingId: string) => Promise<boolean>,
  now: Date = new Date(),
): Promise<{ requeued: number; abandoned: number }> {
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

  const abandoned = await db
    .update(callRecordingsTable)
    .set({ status: "failed", error: "The upload was never finished. Upload the recording again.", updatedAt: now })
    .where(
      and(
        eq(callRecordingsTable.status, "uploading"),
        lt(callRecordingsTable.createdAt, new Date(now.getTime() - UPLOAD_ABANDONED_AFTER_MS)),
      ),
    )
    .returning({ id: callRecordingsTable.id });
  return { requeued, abandoned: abandoned.length };
}
