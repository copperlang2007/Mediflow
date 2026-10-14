/**
 * Listening to a call's recording.
 *
 * Recordings hold clients' health details, so nothing here is a plain file
 * download: the caller has already passed the normal call-scoring checks, the
 * call must be one they may open (an agent only their own), every listen is
 * written to the audit log BEFORE a link is handed out, and the link is signed
 * for ten minutes only. The audit entry holds the recording id and the link's
 * lifetime, never the link, a file name or a phone number.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { auditLogTable, callRecordingsTable, db } from "@workspace/db";
import { loadTranscriptRow, type ScopeFilter } from "./store";

/** How long a listening link works. */
export const LISTEN_LINK_SECONDS = 600;

/** The two storage operations playback needs (the real ObjectStorageService has both). */
export interface RecordingReader {
  getCallRecordingMetadata(objectKey: string): Promise<{ size: number; contentType: string | null } | null>;
  getCallRecordingReadURL(objectKey: string, ttlSec?: number): Promise<string>;
}

export type ListenResult =
  | { ok: true; url: string; expiresInSeconds: number; contentType: string | null; durationSeconds: number | null }
  | { ok: false; httpStatus: 404 | 503; code: "not_found" | "no_recording" | "audio_unavailable" | "storage_unavailable"; message: string };

// Fixed answer for storage failures: the error itself may name the object key, so it is never logged or returned.
const STORAGE_DOWN = {
  ok: false,
  httpStatus: 503,
  code: "storage_unavailable",
  message: "The recording could not be opened right now. Please try again in a moment.",
} as const;

export async function listenLink(input: {
  orgId: string;
  userId: string;
  userRole: string;
  transcriptId: string;
  /** Set for agents, who may only open their own calls. */
  scope: ScopeFilter | undefined;
  storage: RecordingReader;
}): Promise<ListenResult> {
  // Same answer for "missing", "another agency" and "not your call".
  const transcript = await loadTranscriptRow(db, input.orgId, input.transcriptId, input.scope);
  if (!transcript) return { ok: false, httpStatus: 404, code: "not_found", message: "Call not found." };

  const [recording] = await db
    .select({ id: callRecordingsTable.id, objectKey: callRecordingsTable.objectKey, durationSeconds: callRecordingsTable.durationSeconds })
    .from(callRecordingsTable)
    .where(and(eq(callRecordingsTable.orgId, input.orgId), eq(callRecordingsTable.transcriptId, transcript.id), eq(callRecordingsTable.status, "scored")))
    .orderBy(desc(callRecordingsTable.createdAt), desc(callRecordingsTable.id))
    .limit(1);
  if (!recording) {
    return { ok: false, httpStatus: 404, code: "no_recording", message: "There is no recording for this call. Calls added as text have none." };
  }

  let stored: Awaited<ReturnType<RecordingReader["getCallRecordingMetadata"]>>;
  try {
    stored = await input.storage.getCallRecordingMetadata(recording.objectKey);
  } catch {
    return STORAGE_DOWN;
  }
  if (!stored) {
    return { ok: false, httpStatus: 404, code: "audio_unavailable", message: "The audio for this call is no longer in storage." };
  }

  // Logged first: if the log cannot be written, no link is given out.
  await db.insert(auditLogTable).values({
    id: randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    userRole: input.userRole,
    action: "call_recording_listen",
    resourceType: "call_transcript",
    resourceId: transcript.id,
    changes: { recordingId: recording.id, linkSeconds: LISTEN_LINK_SECONDS },
  });

  let url: string;
  try {
    url = await input.storage.getCallRecordingReadURL(recording.objectKey, LISTEN_LINK_SECONDS);
  } catch {
    return STORAGE_DOWN;
  }
  return { ok: true, url, expiresInSeconds: LISTEN_LINK_SECONDS, contentType: stored.contentType, durationSeconds: recording.durationSeconds };
}
