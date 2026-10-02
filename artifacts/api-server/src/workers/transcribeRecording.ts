/**
 * Call recording transcription worker (pg-boss job `transcribe-recording`).
 *
 * One step per run (lib/callScoring/recordings.ts). While Speech-to-Text is
 * still working, or a start attempt failed transiently, the job re-enqueues
 * itself with a delay instead of holding a worker slot. Steps are idempotent,
 * so a duplicate or retried job is harmless.
 */
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { POLL_INTERVAL_SEC, processRecording } from "../lib/callScoring/recordings";
import { logger } from "../lib/logger";

export interface TranscribeRecordingPayload {
  recordingId: string;
}

export async function transcribeRecordingWorker(payload: TranscribeRecordingPayload): Promise<void> {
  if (!payload?.recordingId) return;
  const outcome = await processRecording(payload.recordingId);
  if (outcome === "finished") return;
  const id = await enqueue(
    JOB_NAMES.TRANSCRIBE_RECORDING,
    { recordingId: payload.recordingId },
    { startAfter: outcome === "retry_start" ? 120 : POLL_INTERVAL_SEC },
  );
  if (!id) logger.error({ recordingId: payload.recordingId }, "Transcription: could not queue the next check");
}
