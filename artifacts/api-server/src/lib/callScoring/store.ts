/**
 * Persistence and read-side assembly for call scoring.
 *
 * - Writes go through `persistScoredTranscript` / `persistScore`. The stored
 *   automatic result is INSERT-only (a database trigger also enforces it).
 * - Human review lives in call_score_reviews; the "effective" result is
 *   computed here on read from the immutable result plus that history.
 * - Transcript text, quotes and notes are sealed with PHI field encryption
 *   (seal.ts); nothing here logs or returns plaintext to callers that should
 *   not see it - routes decide who may open what.
 * - Everything takes an explicit orgId and filters on it.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  callScoreFindingsTable,
  callScoresTable,
  callScoreReviewsTable,
  callTranscriptsTable,
  contactsTable,
  type CallContactMatch,
  type CallTranscript,
  type CallTranscriptSource,
} from "@workspace/db";
import { CMS_RECORD_RETENTION_DAYS } from "../compliance/retention";
import { phoneMatchKey, phoneMatchKeySql } from "../compliance/phone";
import type { ScoreRun } from "./engine";
import { getRubric } from "./rubrics";
import { open, redactedTextHash, seal, sealTranscript, type TranscriptPayload } from "./seal";
import { effectiveOverrides, applyOverrides, type OverrideRecord } from "./review";
import { summarizeWith } from "./score";
import type {
  CriterionKind,
  CriterionResult,
  CriterionStatus,
  ParsedTranscript,
  ReviewedStatus,
  Role,
  ScoreTotals,
  Severity,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = PgDatabase<any, any, any>;

export const DNC_CRITERION_ID = "dnc_possible_request";
export const DNC_CRITERION_NAME = "Possible do-not-contact request";

const DAY_MS = 86_400_000;

/** The retention date: created + the CMS 10-year floor. Never shorter. */
export function retainUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + CMS_RECORD_RETENTION_DAYS * DAY_MS);
}

// ---------------------------------------------------------------------------
// Contact matching by phone
// ---------------------------------------------------------------------------

export interface ContactMatch {
  contactId: string | null;
  match: CallContactMatch;
  /** Every contact sharing the number when it is ambiguous (so a reviewer can pick). */
  candidateIds: string[];
}

/**
 * Match by the last 10 digits, and ONLY when it is unambiguous: exactly one
 * live contact in the org carries that number. Two or more is "ambiguous" and
 * nothing is linked; the reviewer picks.
 */
export async function matchContactByPhone(handle: AnyDb, orgId: string, phone: string): Promise<ContactMatch> {
  const key = phoneMatchKey(phone);
  if (!key || key.length < 10) return { contactId: null, match: "none", candidateIds: [] };
  const rows = await handle
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.orgId, orgId),
        sql`${contactsTable.deletedAt} IS NULL`,
        sql`${phoneMatchKeySql(contactsTable.phone)} = ${key}`,
      ),
    )
    .limit(6);
  if (rows.length === 1) return { contactId: rows[0]!.id, match: "phone_unique", candidateIds: [rows[0]!.id] };
  if (rows.length > 1) return { contactId: null, match: "phone_ambiguous", candidateIds: rows.map((r) => r.id) };
  return { contactId: null, match: "none", candidateIds: [] };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface PersistTranscriptArgs {
  orgId: string;
  userId: string;
  parsed: ParsedTranscript;
  run: ScoreRun;
  source: CallTranscriptSource;
  externalRef: string | null;
  callDate: Date | null;
  phone: string | null;
  filename: string | null;
  contactId: string | null;
  contactMatch: CallContactMatch;
  callSessionId: string | null;
  agentId: string | null;
}

export async function persistScoredTranscript(
  handle: AnyDb,
  a: PersistTranscriptArgs,
): Promise<{ transcriptId: string; scoreId: string }> {
  const transcriptId = randomUUID();
  const now = new Date();
  await handle.insert(callTranscriptsTable).values({
    id: transcriptId,
    orgId: a.orgId,
    contactId: a.contactId,
    callSessionId: a.callSessionId,
    agentId: a.agentId,
    source: a.source,
    format: a.parsed.format,
    externalRef: a.externalRef,
    callDate: a.callDate,
    phoneLast10: a.phone ? (phoneMatchKey(a.phone) ?? null) : null,
    contactMatch: a.contactMatch,
    transcriptEncrypted: sealTranscript(a.parsed, { filename: a.filename, phone: a.phone }),
    redactedTextHash: redactedTextHash(a.parsed),
    speakerMode: a.parsed.speakerMode,
    timing: a.parsed.timing,
    utteranceCount: a.parsed.utterances.length,
    durationSeconds: Math.round(a.parsed.durationSec),
    createdBy: a.userId,
    retainUntil: retainUntil(now),
    createdAt: now,
  });
  const scoreId = await persistScore(handle, {
    orgId: a.orgId,
    transcriptId,
    userId: a.userId,
    run: a.run,
    parsed: a.parsed,
  });
  return { transcriptId, scoreId };
}

export async function persistScore(
  handle: AnyDb,
  a: { orgId: string; transcriptId: string; userId: string; run: ScoreRun; parsed: ParsedTranscript },
): Promise<string> {
  const { run } = a;
  const scoreId = randomUUID();
  await handle.insert(callScoresTable).values({
    id: scoreId,
    orgId: a.orgId,
    transcriptId: a.transcriptId,
    rubricId: run.rubric.id,
    rubricVersion: run.rubric.version,
    score: run.totals.score,
    complianceStatus: run.totals.compliance,
    criticalFailureCount: run.totals.criticalFailures.length,
    needsReviewCount: run.totals.needsReview.length,
    dncFlagCount: run.dnc.length,
    method: run.ai.status === "used" ? "rules+ai" : "rules",
    aiStatus: run.ai.status,
    aiModel: run.ai.model,
    aiError: run.ai.error,
    speakerMode: a.parsed.speakerMode,
    scoredBy: a.userId,
  });

  const rows: Array<typeof callScoreFindingsTable.$inferInsert> = [];
  const meta = new Map(run.rubric.criteria.map((c) => [c.id, c]));
  for (const c of run.criteria) {
    const crit = meta.get(c.criterionId);
    if (!crit) continue;
    const base = {
      orgId: a.orgId,
      scoreId,
      transcriptId: a.transcriptId,
      criterionId: c.criterionId,
      criterionName: crit.name,
      kind: crit.kind,
      severity: crit.severity,
      verdict: c.status,
      needsReview: c.status === "needs_review",
      source: c.source,
      fraction: c.fraction,
      maxPoints: c.maxPoints,
    };
    if (!c.evidence.length) {
      rows.push({
        ...base,
        id: randomUUID(),
        fingerprint: `${c.criterionId}:none`,
        evidenceEncrypted: seal({ quote: null, rationale: c.rationale, coaching: c.coaching ?? null }),
      });
      continue;
    }
    for (const e of c.evidence) {
      rows.push({
        ...base,
        id: randomUUID(),
        speaker: e.role === "client" ? "client" : e.role === "agent" ? "agent" : "unknown",
        utteranceIndex: e.utteranceId,
        endUtteranceIndex: e.endUtteranceId,
        startOffset: e.startOffset,
        endOffset: e.endOffset,
        startSeconds: e.startSec,
        fingerprint: `${c.criterionId}:${e.utteranceId}:${e.startOffset}`,
        evidenceEncrypted: seal({
          quote: e.quote,
          rationale: c.rationale,
          coaching: c.coaching ?? null,
          componentId: e.componentId ?? null,
        }),
      });
    }
  }
  for (const d of run.dnc) {
    rows.push({
      id: randomUUID(),
      orgId: a.orgId,
      scoreId,
      transcriptId: a.transcriptId,
      criterionId: DNC_CRITERION_ID,
      criterionName: DNC_CRITERION_NAME,
      kind: "dnc",
      severity: "critical",
      verdict: "flag",
      needsReview: true,
      source: "rules",
      speaker: d.role === "client" ? "client" : "unknown",
      utteranceIndex: d.utteranceId,
      endUtteranceIndex: d.utteranceId,
      startOffset: d.startOffset,
      endOffset: d.endOffset,
      startSeconds: d.startSec,
      fingerprint: d.fingerprint,
      evidenceEncrypted: seal({
        quote: d.quote,
        rationale: "Wording that may be a request to stop contact. A person must confirm before anything changes.",
        coaching: null,
        patternId: d.patternId,
      }),
    });
  }
  if (rows.length) await handle.insert(callScoreFindingsTable).values(rows);
  return scoreId;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ScopeFilter {
  /** Set for the `agent` role: only transcripts linked to a call session this user made. */
  agentUserId?: string;
  agentProfileId?: string | null;
}

/** SQL condition limiting transcripts to a self-scoped agent's own calls (via call_sessions). */
export function agentScopeCondition(scope: ScopeFilter | undefined): SQL | undefined {
  if (!scope?.agentUserId) return undefined;
  const own = scope.agentProfileId
    ? sql`(cs.user_id = ${scope.agentUserId} OR cs.agent_id = ${scope.agentProfileId})`
    : sql`cs.user_id = ${scope.agentUserId}`;
  return sql`${callTranscriptsTable.callSessionId} IS NOT NULL AND EXISTS (
    SELECT 1 FROM call_sessions cs
    WHERE cs.id = ${callTranscriptsTable.callSessionId} AND cs.org_id = ${callTranscriptsTable.orgId} AND ${own}
  )`;
}

export async function loadTranscriptRow(
  handle: AnyDb,
  orgId: string,
  id: string,
  scope?: ScopeFilter,
): Promise<CallTranscript | null> {
  const conds = [eq(callTranscriptsTable.id, id), eq(callTranscriptsTable.orgId, orgId)];
  const s = agentScopeCondition(scope);
  if (s) conds.push(s);
  const [row] = await handle
    .select()
    .from(callTranscriptsTable)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

export function openTranscript(row: CallTranscript): TranscriptPayload | null {
  return open<TranscriptPayload>(row.transcriptEncrypted);
}

export interface LiteCriterion {
  scoreId: string;
  criterionId: string;
  name: string;
  kind: CriterionKind | "dnc";
  severity: Severity;
  verdict: CriterionStatus;
  fraction: number;
  maxPoints: number;
}

export interface EffectiveScore {
  scoreId: string;
  transcriptId: string;
  auto: ScoreTotals;
  effective: ScoreTotals;
  openDnc: number;
  resolvedDnc: number;
  overrides: Map<string, OverrideRecord>;
}

const counted = (s: CriterionStatus) => s === "pass" || s === "partial" || s === "fail";

function toResult(c: LiteCriterion): CriterionResult {
  return {
    criterionId: c.criterionId,
    status: c.verdict,
    fraction: counted(c.verdict) ? c.fraction : 0,
    earned: counted(c.verdict) ? Math.round(c.maxPoints * c.fraction * 10) / 10 : 0,
    maxPoints: c.maxPoints,
    evidence: [],
    rationale: "",
    source: "rules",
  };
}

/** Latest score row for each transcript id (org scoped). */
export async function latestScores(handle: AnyDb, orgId: string, transcriptIds: string[]) {
  if (!transcriptIds.length) return [];
  return handle
    .selectDistinctOn([callScoresTable.transcriptId])
    .from(callScoresTable)
    .where(and(eq(callScoresTable.orgId, orgId), inArray(callScoresTable.transcriptId, transcriptIds)))
    .orderBy(callScoresTable.transcriptId, desc(callScoresTable.createdAt), desc(callScoresTable.id));
}

/** One row per criterion of each score (no decryption). */
export async function loadLiteCriteria(handle: AnyDb, orgId: string, scoreIds: string[]): Promise<LiteCriterion[]> {
  if (!scoreIds.length) return [];
  const t = callScoreFindingsTable;
  const rows = await handle
    .selectDistinctOn([t.scoreId, t.criterionId], {
      scoreId: t.scoreId,
      criterionId: t.criterionId,
      name: t.criterionName,
      kind: t.kind,
      severity: t.severity,
      verdict: t.verdict,
      fraction: t.fraction,
      maxPoints: t.maxPoints,
    })
    .from(t)
    .where(and(eq(t.orgId, orgId), inArray(t.scoreId, scoreIds), sql`${t.kind} <> 'dnc'`))
    .orderBy(t.scoreId, t.criterionId);
  return rows as LiteCriterion[];
}

/**
 * Effective (human-reviewed) totals for a set of scores: the immutable
 * automatic criteria, human overrides applied, and unresolved possible
 * do-not-contact requests counted. Plain data in, plain data out.
 */
export async function computeEffective(
  handle: AnyDb,
  orgId: string,
  scores: Array<{ id: string; transcriptId: string }>,
): Promise<Map<string, EffectiveScore>> {
  const out = new Map<string, EffectiveScore>();
  if (!scores.length) return out;
  const scoreIds = scores.map((s) => s.id);
  const transcriptIds = [...new Set(scores.map((s) => s.transcriptId))];

  const [lite, reviews, dncRows] = await Promise.all([
    loadLiteCriteria(handle, orgId, scoreIds),
    handle
      .select()
      .from(callScoreReviewsTable)
      .where(and(eq(callScoreReviewsTable.orgId, orgId), inArray(callScoreReviewsTable.scoreId, scoreIds)))
      .orderBy(asc(callScoreReviewsTable.createdAt), asc(callScoreReviewsTable.id)),
    handle
      .select({
        scoreId: callScoreFindingsTable.scoreId,
        transcriptId: callScoreFindingsTable.transcriptId,
        fingerprint: callScoreFindingsTable.fingerprint,
      })
      .from(callScoreFindingsTable)
      .where(
        and(
          eq(callScoreFindingsTable.orgId, orgId),
          inArray(callScoreFindingsTable.scoreId, scoreIds),
          eq(callScoreFindingsTable.kind, "dnc"),
        ),
      ),
  ]);
  const resolutions = await handle
    .select({
      transcriptId: callScoreReviewsTable.transcriptId,
      fingerprint: callScoreReviewsTable.fingerprint,
    })
    .from(callScoreReviewsTable)
    .where(
      and(
        eq(callScoreReviewsTable.orgId, orgId),
        eq(callScoreReviewsTable.kind, "dnc_resolution"),
        inArray(callScoreReviewsTable.transcriptId, transcriptIds),
      ),
    );
  const resolved = new Set(resolutions.map((r) => `${r.transcriptId}|${r.fingerprint}`));

  for (const s of scores) {
    const crit = lite.filter((c) => c.scoreId === s.id);
    const critical = new Set(crit.filter((c) => c.severity === "critical").map((c) => c.criterionId));
    const auto = crit.map(toResult);
    const history: OverrideRecord[] = reviews
      .filter((r) => r.scoreId === s.id && r.kind === "override" && r.criterionId)
      .map((r) => ({
        criterionId: r.criterionId!,
        verdict: r.verdict as ReviewedStatus | "revert",
        fraction: r.fraction,
        reviewerUserId: r.reviewerUserId,
        note: "",
        at: r.createdAt.toISOString(),
      }));
    const overrides = effectiveOverrides(history);
    const flags = dncRows.filter((d) => d.scoreId === s.id);
    const openDnc = flags.filter((d) => !resolved.has(`${d.transcriptId}|${d.fingerprint}`)).length;
    out.set(s.id, {
      scoreId: s.id,
      transcriptId: s.transcriptId,
      auto: summarizeWith(critical, auto, flags.length),
      effective: summarizeWith(critical, applyOverrides(auto, overrides), openDnc),
      openDnc,
      resolvedDnc: flags.length - openDnc,
      overrides,
    });
  }
  return out;
}

export interface TranscriptFilters {
  orgId: string;
  scope?: ScopeFilter;
  contactId?: string;
  agentId?: string;
  source?: string;
  rubricId?: string;
  from?: Date;
  to?: Date;
}

/** Transcripts (newest first) matching the SQL-level filters, capped. */
export async function listTranscriptRows(handle: AnyDb, f: TranscriptFilters, cap: number) {
  const t = callTranscriptsTable;
  const conds: SQL[] = [eq(t.orgId, f.orgId)];
  const s = agentScopeCondition(f.scope);
  if (s) conds.push(s);
  if (f.contactId) conds.push(eq(t.contactId, f.contactId));
  if (f.agentId) conds.push(eq(t.agentId, f.agentId));
  if (f.source) conds.push(eq(t.source, f.source));
  if (f.from) conds.push(gte(t.createdAt, f.from));
  if (f.to) conds.push(lte(t.createdAt, f.to));
  return handle
    .select({
      id: t.id,
      contactId: t.contactId,
      callSessionId: t.callSessionId,
      agentId: t.agentId,
      source: t.source,
      format: t.format,
      externalRef: t.externalRef,
      callDate: t.callDate,
      contactMatch: t.contactMatch,
      speakerMode: t.speakerMode,
      timing: t.timing,
      utteranceCount: t.utteranceCount,
      durationSeconds: t.durationSeconds,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(...conds))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(cap);
}

export function roleLabel(r: string | null): Role {
  return r === "agent" || r === "client" ? r : "unknown";
}

export function rubricFor(rubricId: string) {
  return getRubric(rubricId) ?? null;
}
