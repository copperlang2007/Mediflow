/**
 * Create + score one transcript. Shared by the single upload route and the
 * bulk look-back import so both behave identically (same parsing, contact
 * matching, duplicate check, scoring, encryption and audit row).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  agentsTable,
  auditLogTable,
  callSessionsTable,
  callTranscriptsTable,
  contactsTable,
  db,
  type CallContactMatch,
  type CallTranscriptSource,
} from "@workspace/db";
import { runScoring, type RunScoringOptions, type ScoreRun } from "./engine";
import { TranscriptParseError, parseTranscript } from "./parse";
import { persistScore, persistScoredTranscript, matchContactByPhone, loadTranscriptRow, openTranscript } from "./store";
import { contentDigest } from "./seal";
import { getRubric } from "./rubrics";
import type { ParsedTranscript, Rubric, TranscriptFormat } from "./types";

/**
 * In-process keyed mutex. Concurrent uploads of the same call queue behind the
 * first one, so only the first pays for scoring (and the AI call); the rest
 * re-run the duplicate check afterwards and find the winner. No database
 * transaction is held while waiting. The unique (org_id, content_digest) index
 * remains the guarantee across server instances.
 */
const keyLocks = new Map<string, Promise<void>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  keyLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  }
}

export interface Note {
  code: string;
  message: string;
}

export interface IngestInput {
  orgId: string;
  userId: string;
  userRole: string;
  content: string;
  filename: string | null;
  format?: TranscriptFormat | undefined;
  rubric: Rubric;
  source: CallTranscriptSource;
  externalRef: string | null;
  callDate: Date | null;
  phone: string | null;
  contactId: string | null;
  callSessionId: string | null;
  agentId: string | null;
  aiMode: "auto" | "off";
  /** Injected in tests. */
  reviewer?: RunScoringOptions["reviewer"];
}

export interface ScoreSummary {
  transcriptId: string;
  scoreId: string;
  rubric: { id: string; version: string };
  score: number;
  compliance: "pass" | "fail" | "review";
  criticalFailureCount: number;
  needsReviewCount: number;
  dncFlagCount: number;
  ai: { status: string; model: string | null; error: string | null };
  speakerMode: string;
  timing: string;
  contact: { id: string | null; match: string };
  notes: Note[];
}

export type IngestResult =
  | { kind: "ok"; summary: ScoreSummary }
  | { kind: "duplicate"; transcriptId: string }
  | { kind: "error"; httpStatus: number; code: string; message: string };

/** Honest, plain-language caveats about how far to trust a score. */
export function buildNotes(parsed: ParsedTranscript, run: ScoreRun, contactMatch: CallContactMatch, hadPhone: boolean): Note[] {
  const notes: Note[] = [];
  if (parsed.speakerMode === "unlabelled") {
    notes.push({
      code: "speakers_unlabelled",
      message:
        "This file has no agent or client labels, so every turn is treated as an unknown speaker. Disclosure checks search all speech, and possible problems go to a person instead of failing the agent.",
    });
  } else if (parsed.speakerMode === "partial") {
    notes.push({
      code: "speakers_partial",
      message: "Only one side of the call is labelled. The other side is treated as an unknown speaker.",
    });
  }
  if (parsed.timing === "estimated") {
    notes.push({
      code: "timing_estimated",
      message:
        "This file has no timestamps, so times are estimated from word counts. Checks that depend on time (like the first-minute disclaimer) are sent to a person when they would fail.",
    });
  }
  if (run.ai.status === "needs_setup") {
    notes.push({
      code: "ai_needs_setup",
      message: "AI review is not set up, so judgment items are marked needs review. Rule checks and the do-not-contact check still ran.",
    });
  } else if (run.ai.status === "failed") {
    notes.push({ code: "ai_failed", message: `${run.ai.error ?? "The AI reviewer failed."} Judgment items are marked needs review.` });
  } else if (run.ai.status === "skipped") {
    notes.push({ code: "ai_skipped", message: "Rules only: the AI reviewer was not run for this transcript." });
  }
  if (contactMatch === "phone_ambiguous") {
    notes.push({
      code: "contact_ambiguous",
      message: "More than one client uses this phone number, so no client was linked. A reviewer picks one when confirming a do-not-contact request.",
    });
  } else if (contactMatch === "none" && hadPhone) {
    notes.push({ code: "contact_not_found", message: "No client matched the phone number, so the transcript is not linked to a client." });
  }
  return notes;
}

export async function ingestTranscript(input: IngestInput): Promise<IngestResult> {
  const { orgId } = input;

  let parsed: ParsedTranscript;
  try {
    parsed = parseTranscript(input.content, { filename: input.filename ?? undefined, format: input.format });
  } catch (err) {
    if (err instanceof TranscriptParseError) return { kind: "error", httpStatus: 400, code: "unreadable", message: err.message };
    throw err;
  }

  // Who / what does it belong to? Everything is checked against the caller's org.
  let contactId = input.contactId;
  let contactMatch: CallContactMatch = "none";
  let agentId = input.agentId;

  let sessionAgentId: string | null = null;
  let sessionContactId: string | null = null;
  if (input.callSessionId) {
    const [s] = await db
      .select({ id: callSessionsTable.id, agentId: callSessionsTable.agentId, contactId: callSessionsTable.contactId })
      .from(callSessionsTable)
      .where(and(eq(callSessionsTable.id, input.callSessionId), eq(callSessionsTable.orgId, orgId)))
      .limit(1);
    if (!s) return { kind: "error", httpStatus: 404, code: "call_not_found", message: "Call not found." };
    sessionAgentId = s.agentId;
    sessionContactId = s.contactId;
  }
  if (contactId) {
    const [c] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId), sql`${contactsTable.deletedAt} IS NULL`))
      .limit(1);
    if (!c) return { kind: "error", httpStatus: 404, code: "contact_not_found", message: "Contact not found." };
    contactMatch = "explicit";
  } else if (sessionContactId) {
    contactId = sessionContactId;
    contactMatch = "explicit";
  } else if (input.phone) {
    const m = await matchContactByPhone(db, orgId, input.phone);
    contactId = m.contactId;
    contactMatch = m.match;
  }
  if (agentId) {
    const [a] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
      .limit(1);
    if (!a) return { kind: "error", httpStatus: 404, code: "agent_not_found", message: "Agent not found." };
  } else if (sessionAgentId) {
    agentId = sessionAgentId;
  }

  const digest = contentDigest(parsed);
  return withKeyLock(`${orgId}|${digest.toString("hex")}`, () => scoreAndStore());

  async function scoreAndStore(): Promise<IngestResult> {
  // Same original speech already scored in this org? Do not create a second copy.
  // (Cheap early exit, re-run by every waiter; the unique index in
  // persistScoredTranscript is the guarantee across instances.)
  const [dup] = await db
    .select({ id: callTranscriptsTable.id })
    .from(callTranscriptsTable)
    .where(and(eq(callTranscriptsTable.orgId, orgId), eq(callTranscriptsTable.contentDigest, digest)))
    .limit(1);
  if (dup) return { kind: "duplicate", transcriptId: dup.id };

  const run = await runScoring({ rubric: input.rubric, transcript: parsed, ai: input.aiMode, reviewer: input.reviewer });

  const outcome = await db.transaction(async (tx) => {
    const created = await persistScoredTranscript(tx, {
      orgId,
      userId: input.userId,
      parsed,
      run,
      source: input.source,
      externalRef: input.externalRef,
      callDate: input.callDate,
      phone: input.phone,
      filename: input.filename,
      contactId,
      contactMatch,
      callSessionId: input.callSessionId,
      agentId,
    });
    if ("duplicateOf" in created) return created;
    await tx.insert(auditLogTable).values({
      id: randomUUID(),
      orgId,
      userId: input.userId,
      userRole: input.userRole,
      action: "create",
      resourceType: "call_transcript",
      resourceId: created.transcriptId,
      // Counts and states only: never the text, a filename, a phone number or a quote.
      changes: {
        source: input.source,
        format: parsed.format,
        rubricId: run.rubric.id,
        speakerMode: parsed.speakerMode,
        contactMatch,
        compliance: run.totals.compliance,
        dncFlags: run.dnc.length,
        ai: run.ai.status,
      },
    });
    return created;
  });
  if ("duplicateOf" in outcome) return { kind: "duplicate", transcriptId: outcome.duplicateOf };
  const ids = outcome;

  return {
    kind: "ok",
    summary: summarize(ids.transcriptId, ids.scoreId, run, parsed, contactId, contactMatch, Boolean(input.phone)),
  };
  }
}

function summarize(
  transcriptId: string,
  scoreId: string,
  run: ScoreRun,
  parsed: ParsedTranscript,
  contactId: string | null,
  contactMatch: CallContactMatch,
  hadPhone: boolean,
): ScoreSummary {
  return {
    transcriptId,
    scoreId,
    rubric: { id: run.rubric.id, version: run.rubric.version },
    score: run.totals.score,
    compliance: run.totals.compliance,
    criticalFailureCount: run.totals.criticalFailures.length,
    needsReviewCount: run.totals.needsReview.length,
    dncFlagCount: run.dnc.length,
    ai: run.ai,
    speakerMode: parsed.speakerMode,
    timing: parsed.timing,
    contact: { id: contactId, match: contactMatch },
    notes: buildNotes(parsed, run, contactMatch, hadPhone),
  };
}

/** Score an existing transcript again. The earlier score and its reviews stay as history. */
export async function rescoreTranscript(input: {
  orgId: string;
  userId: string;
  userRole: string;
  transcriptId: string;
  rubric: Rubric;
  aiMode: "auto" | "off";
  reviewer?: RunScoringOptions["reviewer"];
}): Promise<IngestResult> {
  const row = await loadTranscriptRow(db, input.orgId, input.transcriptId);
  if (!row) return { kind: "error", httpStatus: 404, code: "not_found", message: "Transcript not found." };
  const payload = openTranscript(row);
  if (!payload || !payload.utterances.length) {
    return { kind: "error", httpStatus: 409, code: "text_unavailable", message: "The transcript text is no longer available to score." };
  }
  const parsed: ParsedTranscript = {
    utterances: payload.utterances,
    speakerMode: row.speakerMode as ParsedTranscript["speakerMode"],
    timing: row.timing as ParsedTranscript["timing"],
    durationSec: row.durationSeconds ?? payload.utterances[payload.utterances.length - 1]!.endSec,
    format: row.format as TranscriptFormat,
  };
  const run = await runScoring({ rubric: input.rubric, transcript: parsed, ai: input.aiMode, reviewer: input.reviewer });
  const scoreId = await db.transaction(async (tx) => {
    const id = await persistScore(tx, { orgId: input.orgId, transcriptId: row.id, userId: input.userId, run, parsed });
    await tx.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      userRole: input.userRole,
      action: "call_rescore",
      resourceType: "call_transcript",
      resourceId: row.id,
      changes: { rubricId: run.rubric.id, compliance: run.totals.compliance, dncFlags: run.dnc.length, ai: run.ai.status },
    });
    return id;
  });
  return {
    kind: "ok",
    summary: summarize(row.id, scoreId, run, parsed, row.contactId, row.contactMatch as CallContactMatch, false),
  };
}

export function resolveRubric(id: string | undefined, fallback: Rubric): Rubric | null {
  if (!id) return fallback;
  return getRubric(id) ?? null;
}

