/**
 * EnrollHere call-log import: the CSV an agency exports from EnrollHere's
 * call logs (one row per call, with a "Recording URL" column).
 *
 * Each row is kept whole (every column, encrypted, 10-year retention) in
 * `integration_payloads` with source `enrollhere_call_log`, keyed by the
 * EnrollHere call ID so the same row in a later export is not stored twice.
 * Calls with a recording link and at least MIN_SCORED_CALL_SECONDS in call
 * become `call_recordings` rows in status `fetching`: the transcription job
 * downloads the audio (lib/callScoring/recordings.ts), transcribes it and
 * scores it with the chosen checklist.
 *
 * Re-importing a file is safe and is also the retry: a call whose recording
 * never reached Speech-to-Text (expired link, daily cap) is queued again with
 * the fresh link; anything further along is reported as already imported.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentsTable, callRecordingsTable, db, encryptPii, integrationPayloadsTable } from "@workspace/db";
import { CsvFileError, parseCsvTolerant } from "../csvImport";
import { canonicalJson } from "../integrations/payload";
import { enqueue, JOB_NAMES, transcribeJobKey } from "../jobs";
import { logger } from "../logger";
import { enrollhereRecordingUrl } from "./enrollhereRecordingLink";
import type { RecordingDetails } from "./recordings";
import { seal } from "./seal";
import { matchContactByPhone, retainUntil } from "./store";

export const CALL_LOG_SOURCE = "enrollhere_call_log";
/** Shorter calls are kept but not transcribed: too short to score, and each costs Speech-to-Text time. */
export const MIN_SCORED_CALL_SECONDS = 60;
export const MAX_CALL_LOG_ROWS = 5000;
/** EnrollHere writes "Created At" as local wall time with no zone; the agency's dialer runs on US Central. */
export const CALL_LOG_TIMEZONE = "America/Chicago";

export type CallLogOutcome =
  | "queued" // stored; recording is being downloaded and scored
  | "requeued" // seen before; its recording had not reached transcription, so it was queued again
  | "duplicate" // seen before; nothing to do
  | "stored_short" // stored; call too short to score
  | "stored_no_recording" // stored; no recording link
  | "stored_bad_link" // stored; the link is not EnrollHere's recording storage
  | "stored_not_transcribed" // stored; audio transcription is not set up
  | "error";

export interface CallLogRowResult {
  /** Line in the file the row starts on. */
  line: number;
  /** EnrollHere's call ID (not PHI). */
  callId: string | null;
  outcome: CallLogOutcome;
  recordingId?: string;
  message?: string;
}

export interface CallLogSummary {
  rows: number;
  stored: number;
  duplicates: number;
  queued: number;
  requeued: number;
  notScored: { short: number; noRecording: number; badLink: number; notTranscribed: number };
  errors: number;
  /** Rows the CSV parser could not read at all (line numbers and reasons, no values). */
  unreadable: string[];
  results: CallLogRowResult[];
}

interface CallLogRow {
  line: number;
  values: Record<string, string>;
}

const COL = {
  id: "id",
  recordingUrl: "recording url",
  createdAt: "created at",
  durationInCall: "duration in call",
  billableSeconds: "billable seconds",
  agentEmail: "agent email",
  leadPhone: "lead phone",
} as const;

/** Parse and check the export. Throws CsvFileError (a safe, plain message) when it is not an EnrollHere call log. */
export function readCallLog(buf: Buffer): { rows: CallLogRow[]; unreadable: string[] } {
  const parsed = parseCsvTolerant(buf);
  const lower = new Set(parsed.headers.map((h) => h.trim().toLowerCase()));
  if (!lower.has(COL.id) || !lower.has(COL.recordingUrl)) {
    throw new CsvFileError('This does not look like an EnrollHere call log: it needs the "ID" and "Recording URL" columns.');
  }
  if (parsed.rows.length > MAX_CALL_LOG_ROWS) {
    throw new CsvFileError(`The file has ${parsed.rows.length} calls; import at most ${MAX_CALL_LOG_ROWS} at a time.`);
  }
  const unreadable = parsed.issues.filter((i) => i.severity === "error").map((i) => `Line ${i.row}: ${i.message}`);
  return { rows: parsed.rows.map((values, i) => ({ line: parsed.rowNumbers[i] ?? i + 2, values })), unreadable };
}

function cell(values: Record<string, string>, name: string): string {
  for (const [k, v] of Object.entries(values)) if (k.trim().toLowerCase() === name) return (v ?? "").trim();
  return "";
}

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
}

/** "10/09/2026, 1:54:25 PM" (wall time in `tz`) → instant; null when unreadable. */
export function parseCallLogTime(raw: string, tz: string = CALL_LOG_TIMEZONE): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(raw.trim());
  if (!m) return null;
  const [, mo, d, y, hRaw, mi, s, ap] = m;
  let h = Number(hRaw);
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
  }
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), h, Number(mi), Number(s ?? 0));
  if (Number.isNaN(wall) || h > 23 || Number(mi) > 59 || Number(mo) > 12 || Number(d) > 31) return null;
  // Two passes settle the offset across a DST change.
  let utc = wall - zoneOffset(wall, tz);
  utc = wall - zoneOffset(utc, tz);
  return new Date(utc);
}

/** Seconds the agent and client were connected. "Duration In Call" is milliseconds; "Billable Seconds" is the fallback. */
export function callSeconds(values: Record<string, string>): number | null {
  const ms = Number(cell(values, COL.durationInCall));
  if (cell(values, COL.durationInCall) && Number.isFinite(ms)) return Math.round(ms / 1000);
  const s = Number(cell(values, COL.billableSeconds));
  return cell(values, COL.billableSeconds) && Number.isFinite(s) ? Math.round(s) : null;
}

/** One recording row per agency and EnrollHere call, so a re-import finds it (UUID-shaped, from a hash). */
export function recordingIdFor(orgId: string, callId: string): string {
  const h = createHash("sha256").update(`enrollhere-call-log:${orgId}:${callId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface ImportCallLogInput {
  orgId: string;
  userId: string;
  userRole: string;
  rows: CallLogRow[];
  unreadable: string[];
  rubricId: string;
  /** False when Speech-to-Text is not set up: every value is still stored. */
  transcribe: boolean;
  /** Bucket key for a recording (ObjectStorageService.callRecordingKey). */
  objectKey: (orgId: string, recordingId: string) => string;
}

export async function importCallLog(input: ImportCallLogInput): Promise<CallLogSummary> {
  const { orgId } = input;
  // Agent Email → this agency's agent; an email shared by two agents links neither.
  const agents = await db.select({ id: agentsTable.id, email: agentsTable.email }).from(agentsTable).where(eq(agentsTable.orgId, orgId));
  const agentByEmail = new Map<string, string | null>();
  for (const a of agents) {
    const k = a.email?.trim().toLowerCase();
    if (k) agentByEmail.set(k, agentByEmail.has(k) ? null : a.id);
  }

  const results: CallLogRowResult[] = [];
  const toQueue: string[] = [];
  for (const { line, values } of input.rows) {
    const callId = cell(values, COL.id);
    if (!callId || callId.length > 120) {
      results.push({ line, callId: null, outcome: "error", message: "The row has no call ID, so it was not imported." });
      continue;
    }
    try {
      const result = await importRow(input, line, callId, values, agentByEmail);
      results.push(result);
      if ((result.outcome === "queued" || result.outcome === "requeued") && result.recordingId) toQueue.push(result.recordingId);
    } catch (err) {
      // One bad row must not stop the file. Never log values: the row is PHI.
      logger.error({ errName: (err as Error).name, orgId, line }, "EnrollHere call log: row failed");
      results.push({ line, callId, outcome: "error", message: "This call could not be imported. Import the file again to retry it." });
    }
  }

  for (const recordingId of toQueue) {
    const jobId = await enqueue(JOB_NAMES.TRANSCRIBE_RECORDING, { recordingId }, { singletonKey: transcribeJobKey(recordingId) });
    // The recordings sweep re-queues a `fetching` row nobody has looked at.
    if (!jobId) logger.warn({ recordingId }, "EnrollHere call log: download not queued now; the sweep will pick it up");
  }

  const count = (o: CallLogOutcome) => results.filter((r) => r.outcome === o).length;
  const stored = ["queued", "stored_short", "stored_no_recording", "stored_bad_link", "stored_not_transcribed"] as const;
  return {
    rows: input.rows.length,
    stored: stored.reduce((n, o) => n + count(o), 0),
    duplicates: count("duplicate"),
    queued: count("queued"),
    requeued: count("requeued"),
    notScored: {
      short: count("stored_short"),
      noRecording: count("stored_no_recording"),
      badLink: count("stored_bad_link"),
      notTranscribed: count("stored_not_transcribed"),
    },
    errors: count("error"),
    unreadable: input.unreadable,
    results,
  };
}

async function importRow(
  input: ImportCallLogInput,
  line: number,
  callId: string,
  values: Record<string, string>,
  agentByEmail: Map<string, string | null>,
): Promise<CallLogRowResult> {
  const { orgId } = input;
  const phone = cell(values, COL.leadPhone) || null;
  const contactId = phone ? (await matchContactByPhone(db, orgId, phone)).contactId : null;
  const rawUrl = cell(values, COL.recordingUrl);
  const url = enrollhereRecordingUrl(rawUrl);
  const seconds = callSeconds(values);
  const scorable = Boolean(url) && seconds !== null && seconds >= MIN_SCORED_CALL_SECONDS && input.transcribe;
  const recordingId = recordingIdFor(orgId, callId);
  const now = new Date();
  const details: RecordingDetails = {
    filename: `EnrollHere call ${callId}`.slice(0, 200),
    phone: phone?.slice(0, 30) ?? null,
    externalRef: callId,
    uploaderRole: input.userRole,
    sourceUrl: url?.toString() ?? null,
  };

  return db.transaction(async (tx) => {
    const sealed = encryptPii(canonicalJson(values as never));
    const inserted = await tx
      .insert(integrationPayloadsTable)
      .values({
        id: randomUUID(),
        orgId,
        source: CALL_LOG_SOURCE,
        externalId: callId,
        eventType: "call_log",
        contactId,
        payloadEncrypted: sealed.encrypted,
        payloadHmac: sealed.hash,
        retainUntil: retainUntil(now),
      })
      .onConflictDoNothing()
      .returning({ id: integrationPayloadsTable.id });

    if (!inserted.length) {
      // Seen before: retry a recording that never reached Speech-to-Text, with this file's fresh link.
      if (!scorable) return { line, callId, outcome: "duplicate" as const };
      const [rec] = await tx
        .select({ status: callRecordingsTable.status, attempts: callRecordingsTable.attempts })
        .from(callRecordingsTable)
        .where(and(eq(callRecordingsTable.id, recordingId), eq(callRecordingsTable.orgId, orgId)))
        .limit(1);
      if (rec && !(rec.status === "failed" && rec.attempts === 0)) return { line, callId, outcome: "duplicate" as const };
      if (rec) {
        await tx
          .update(callRecordingsTable)
          .set({ status: "fetching", detailsEncrypted: seal(details), error: null, sizeBytes: null, purgeAfter: null, purgeAttempts: 0, checkedAt: null, updatedAt: now })
          .where(and(eq(callRecordingsTable.id, recordingId), eq(callRecordingsTable.status, "failed"), eq(callRecordingsTable.attempts, 0)));
        return { line, callId, outcome: "requeued" as const, recordingId };
      }
      await insertRecording(tx, input, recordingId, details, values, contactId, agentByEmail, now);
      return { line, callId, outcome: "requeued" as const, recordingId };
    }

    if (!rawUrl) return { line, callId, outcome: "stored_no_recording" as const };
    if (!url) return { line, callId, outcome: "stored_bad_link" as const, message: "The recording link is not an EnrollHere recording link, so it was not downloaded." };
    if (seconds === null || seconds < MIN_SCORED_CALL_SECONDS) {
      return { line, callId, outcome: "stored_short" as const, message: `Under ${MIN_SCORED_CALL_SECONDS} seconds in call, so it was not scored.` };
    }
    if (!input.transcribe) return { line, callId, outcome: "stored_not_transcribed" as const, message: "Audio transcription is not set up, so it was not scored." };
    await insertRecording(tx, input, recordingId, details, values, contactId, agentByEmail, now);
    return { line, callId, outcome: "queued" as const, recordingId };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertRecording(
  tx: Tx,
  input: ImportCallLogInput,
  recordingId: string,
  details: RecordingDetails,
  values: Record<string, string>,
  contactId: string | null,
  agentByEmail: Map<string, string | null>,
  now: Date,
): Promise<void> {
  const email = cell(values, COL.agentEmail).toLowerCase();
  await tx
    .insert(callRecordingsTable)
    .values({
      id: recordingId,
      orgId: input.orgId,
      status: "fetching",
      layout: "mono",
      objectKey: input.objectKey(input.orgId, recordingId),
      detailsEncrypted: seal(details),
      agentId: (email && agentByEmail.get(email)) || null,
      contactId,
      callDate: parseCallLogTime(cell(values, COL.createdAt)),
      rubricId: input.rubricId,
      aiMode: "auto",
      source: "enrollhere_download",
      createdBy: input.userId,
      retainUntil: retainUntil(now),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}
