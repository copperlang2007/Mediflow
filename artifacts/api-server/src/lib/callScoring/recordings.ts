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
 *   scored        → linked to its call_transcripts row
 *   failed        → a plain reason, safe to show (never transcript text)
 *
 * Each step is idempotent: it re-reads the row and only acts on the status it
 * expects, so a retried or duplicated job never starts a second transcription
 * or scores the same call twice (ingestTranscript also dedupes by content).
 */
import { and, eq } from "drizzle-orm";
import { db, callRecordingsTable, type CallRecordingLayout } from "@workspace/db";
import { logger } from "../logger";
import { open } from "./seal";
import { DEFAULT_RUBRIC_ID, getRubric } from "./rubrics";
import { ingestTranscript, resolveRubric } from "./ingest";
import type { Rubric } from "./types";
import { gsUri, pollTranscription, resultsToTurns, speechSetup, startTranscription } from "./speech";

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

async function fail(id: string, reason: string, extra: { attempts?: number } = {}): Promise<StepOutcome> {
  await db.update(callRecordingsTable)
    .set({ status: "failed", error: reason, updatedAt: new Date(), ...extra })
    .where(eq(callRecordingsTable.id, id));
  return "finished";
}

export async function processRecording(recordingId: string, deps: { privateObjectDir?: string } = {}): Promise<StepOutcome> {
  const [row] = await db.select().from(callRecordingsTable).where(eq(callRecordingsTable.id, recordingId)).limit(1);
  if (!row || row.status === "scored" || row.status === "failed" || row.status === "uploading") return "finished";

  const setup = speechSetup();
  if (!setup.ready) return fail(row.id, setup.message);
  const layout = row.layout as CallRecordingLayout;

  if (row.status === "queued") {
    const dir = deps.privateObjectDir ?? process.env.PRIVATE_OBJECT_DIR ?? "";
    try {
      const operationName = await startTranscription(gsUri(dir, row.objectKey), layout);
      // Claim the transition: only the job that moves queued → transcribing keeps its operation.
      const moved = await db.update(callRecordingsTable)
        .set({ status: "transcribing", operationName, attempts: row.attempts + 1, error: null, updatedAt: new Date() })
        .where(and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "queued")))
        .returning({ id: callRecordingsTable.id });
      return moved.length ? "poll" : "finished";
    } catch (err) {
      logger.warn({ err: (err as Error).message, recordingId: row.id }, "Speech-to-Text: could not start transcription");
      const attempts = row.attempts + 1;
      if (attempts >= MAX_START_ATTEMPTS) return fail(row.id, "Speech-to-Text could not start transcribing this recording. Check the Speech-to-Text setup, then upload it again.", { attempts });
      await db.update(callRecordingsTable).set({ attempts, updatedAt: new Date() }).where(eq(callRecordingsTable.id, row.id));
      return "retry_start";
    }
  }

  // transcribing
  if (!row.operationName) return fail(row.id, "The transcription job reference was lost. Upload the recording again.");
  let poll;
  try {
    poll = await pollTranscription(row.operationName);
  } catch (err) {
    logger.warn({ err: (err as Error).message, recordingId: row.id }, "Speech-to-Text: poll failed; will retry");
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
      error: result.kind === "duplicate" ? "This call had already been scored; linked to the existing transcript." : null,
      updatedAt: new Date(),
    })
    .where(eq(callRecordingsTable.id, row.id));
  return "finished";
}
