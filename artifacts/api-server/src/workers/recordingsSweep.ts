/**
 * Call recording sweep (scheduled cron, every 10 minutes).
 *
 * The transcription job re-enqueues itself after each step; if one enqueue
 * fails or a job is lost, the recording would sit in queued / transcribing
 * forever. This puts those back on the queue and fails uploads that were
 * never confirmed. See sweepStalledRecordings in lib/callScoring/recordings.ts.
 */
import { enqueue, JOB_NAMES, transcribeJobKey } from "../lib/jobs";
import { sweepStalledRecordings } from "../lib/callScoring/recordings";
import { logger } from "../lib/logger";

export async function recordingsSweepWorker(): Promise<void> {
  const summary = await sweepStalledRecordings(async (recordingId) =>
    Boolean(await enqueue(JOB_NAMES.TRANSCRIBE_RECORDING, { recordingId }, { singletonKey: transcribeJobKey(recordingId) })),
  );
  if (summary.requeued || summary.abandoned) logger.info({ ...summary }, "Call recording sweep finished");
}
