/**
 * Read models for the call-scoring API: the list, the summary and the detail
 * view. All of them show the EFFECTIVE result (the immutable automatic grade
 * with human overrides and do-not-contact resolutions applied) next to the
 * automatic one, so a reviewer always sees both.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  agentsTable,
  callScoreFindingsTable,
  callScoreReviewsTable,
  callScoresTable,
  callTranscriptsTable,
  contactsTable,
  db,
  usersTable,
  type CallTranscript,
} from "@workspace/db";
import {
  DNC_CRITERION_ID,
  computeEffective,
  latestScores,
  listTranscriptRows,
  loadTranscriptRow,
  openTranscript,
  roleLabel,
  rubricFor,
  type EffectiveScore,
  type ScopeFilter,
  type TranscriptFilters,
} from "./store";
import { open } from "./seal";
import { meetsStandard } from "./score";
import type { CriterionStatus, Role, Utterance } from "./types";

export const DISCLAIMER =
  "Call scoring assists review. It is not legal advice and not a compliance certification. A person should confirm anything that matters.";

const LIST_CAP = 5000;

const fullName = (f: string | null, l: string | null) => `${f ?? ""} ${l ?? ""}`.trim() || "Unnamed";

async function namesFor(orgId: string, contactIds: string[], agentIds: string[]) {
  const contacts = new Map<string, string>();
  const agents = new Map<string, string>();
  if (contactIds.length) {
    const rows = await db
      .select({ id: contactsTable.id, f: contactsTable.firstName, l: contactsTable.lastName })
      .from(contactsTable)
      .where(and(eq(contactsTable.orgId, orgId), inArray(contactsTable.id, contactIds)));
    for (const r of rows) contacts.set(r.id, fullName(r.f, r.l));
  }
  if (agentIds.length) {
    const rows = await db
      .select({ id: agentsTable.id, f: agentsTable.firstName, l: agentsTable.lastName })
      .from(agentsTable)
      .where(and(eq(agentsTable.orgId, orgId), inArray(agentsTable.id, agentIds)));
    for (const r of rows) agents.set(r.id, fullName(r.f, r.l));
  }
  return { contacts, agents };
}

export interface ListArgs extends Omit<TranscriptFilters, "orgId"> {
  orgId: string;
  compliance?: "pass" | "fail" | "review" | undefined;
  dnc?: "open" | undefined;
  limit: number;
  offset: number;
}

interface Scored {
  row: Awaited<ReturnType<typeof listTranscriptRows>>[number];
  score: Awaited<ReturnType<typeof latestScores>>[number];
  eff: EffectiveScore;
}

async function loadScored(args: TranscriptFilters, rubricId?: string): Promise<{ scored: Scored[]; truncated: boolean }> {
  const rows = await listTranscriptRows(db, args, LIST_CAP);
  const scores = await latestScores(
    db,
    args.orgId,
    rows.map((r) => r.id),
  );
  const byTranscript = new Map(scores.map((s) => [s.transcriptId, s]));
  const eff = await computeEffective(
    db,
    args.orgId,
    scores.map((s) => ({ id: s.id, transcriptId: s.transcriptId })),
  );
  const scored: Scored[] = [];
  for (const row of rows) {
    const score = byTranscript.get(row.id);
    const e = score ? eff.get(score.id) : undefined;
    if (!score || !e) continue;
    if (rubricId && score.rubricId !== rubricId) continue;
    scored.push({ row, score, eff: e });
  }
  return { scored, truncated: rows.length >= LIST_CAP };
}

export async function buildList(args: ListArgs & { rubricId?: string | undefined }) {
  const { scored, truncated } = await loadScored(args, args.rubricId);
  const filtered = scored.filter(
    (s) => (!args.compliance || s.eff.effective.compliance === args.compliance) && (!args.dnc || s.eff.openDnc > 0),
  );
  const page = filtered.slice(args.offset, args.offset + args.limit);
  const names = await namesFor(
    args.orgId,
    page.map((p) => p.row.contactId).filter((x): x is string => Boolean(x)),
    page.map((p) => p.row.agentId).filter((x): x is string => Boolean(x)),
  );
  return {
    total: filtered.length,
    truncated,
    items: page.map(({ row, score, eff }) => {
      const rubric = rubricFor(score.rubricId);
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        callDate: row.callDate ? row.callDate.toISOString() : null,
        source: row.source,
        format: row.format,
        externalRef: row.externalRef,
        speakerMode: row.speakerMode,
        timing: row.timing,
        callSessionLinked: Boolean(row.callSessionId),
        contact: row.contactId ? { id: row.contactId, name: names.contacts.get(row.contactId) ?? "Unnamed" } : null,
        contactMatch: row.contactMatch,
        agent: row.agentId ? { id: row.agentId, name: names.agents.get(row.agentId) ?? "Unnamed" } : null,
        rubric: { id: score.rubricId, version: score.rubricVersion },
        scoreId: score.id,
        scoredAt: score.createdAt.toISOString(),
        score: eff.effective.score,
        autoScore: score.score,
        compliance: eff.effective.compliance,
        autoCompliance: score.complianceStatus,
        meetsStandard: rubric ? meetsStandard(rubric, eff.effective) : null,
        criticalFailureCount: eff.effective.criticalFailures.length,
        needsReviewCount: eff.effective.needsReview.length,
        openDnc: eff.openDnc,
        reviewed: eff.overrides.size > 0 || eff.resolvedDnc > 0,
        ai: { status: score.aiStatus, model: score.aiModel },
      };
    }),
  };
}

interface Bucket {
  total: number;
  pass: number;
  fail: number;
  review: number;
  scoreSum: number;
}
const bucket = (): Bucket => ({ total: 0, pass: 0, fail: 0, review: 0, scoreSum: 0 });
const bump = (b: Bucket, compliance: "pass" | "fail" | "review", score: number) => {
  b.total++;
  b[compliance]++;
  b.scoreSum += score;
};
const finish = (b: Bucket) => ({
  total: b.total,
  pass: b.pass,
  fail: b.fail,
  review: b.review,
  avgScore: b.total ? Math.round(b.scoreSum / b.total) : null,
});

/** Counts by human-reviewed compliance status, by agent and by rubric. Real rows only. */
export async function buildSummary(args: TranscriptFilters) {
  const { scored, truncated } = await loadScored(args);
  const all = bucket();
  const byAgent = new Map<string, Bucket>();
  const byRubric = new Map<string, Bucket>();
  let openDnc = 0;
  let needsReviewItems = 0;
  for (const { row, score, eff } of scored) {
    const c = eff.effective.compliance;
    bump(all, c, eff.effective.score);
    bump(byAgent.get(row.agentId ?? "") ?? byAgent.set(row.agentId ?? "", bucket()).get(row.agentId ?? "")!, c, eff.effective.score);
    const rk = `${score.rubricId}@${score.rubricVersion}`;
    bump(byRubric.get(rk) ?? byRubric.set(rk, bucket()).get(rk)!, c, eff.effective.score);
    openDnc += eff.openDnc;
    needsReviewItems += eff.effective.needsReview.length;
  }
  const names = await namesFor(args.orgId, [], [...byAgent.keys()].filter(Boolean));
  return {
    truncated,
    totals: { ...finish(all), openDnc, needsReviewItems },
    byAgent: [...byAgent.entries()]
      .map(([agentId, b]) => ({ agentId: agentId || null, name: agentId ? (names.agents.get(agentId) ?? "Unnamed") : null, ...finish(b) }))
      .sort((a, b) => b.total - a.total),
    byRubric: [...byRubric.entries()].map(([key, b]) => {
      const [id, version] = key.split("@") as [string, string];
      return { rubricId: id, rubricVersion: version, name: rubricFor(id)?.name ?? id, ...finish(b) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface EvidencePayload {
  quote: string | null;
  rationale: string;
  coaching: string | null;
  componentId?: string | null;
  patternId?: string;
}

export async function buildDetail(orgId: string, transcriptId: string, scope: ScopeFilter | undefined) {
  const row: CallTranscript | null = await loadTranscriptRow(db, orgId, transcriptId, scope);
  if (!row) return null;
  const payload = openTranscript(row);
  const utterances: Utterance[] = payload?.utterances ?? [];

  const [score] = await db
    .select()
    .from(callScoresTable)
    .where(and(eq(callScoresTable.orgId, orgId), eq(callScoresTable.transcriptId, row.id)))
    .orderBy(desc(callScoresTable.createdAt), desc(callScoresTable.id))
    .limit(1);
  const allScores = await db
    .select({
      id: callScoresTable.id,
      createdAt: callScoresTable.createdAt,
      score: callScoresTable.score,
      compliance: callScoresTable.complianceStatus,
      rubricId: callScoresTable.rubricId,
      rubricVersion: callScoresTable.rubricVersion,
    })
    .from(callScoresTable)
    .where(and(eq(callScoresTable.orgId, orgId), eq(callScoresTable.transcriptId, row.id)))
    .orderBy(desc(callScoresTable.createdAt));

  const names = await namesFor(orgId, row.contactId ? [row.contactId] : [], row.agentId ? [row.agentId] : []);
  const base = {
    transcript: {
      id: row.id,
      source: row.source,
      format: row.format,
      externalRef: row.externalRef,
      callDate: row.callDate ? row.callDate.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      retainUntil: row.retainUntil.toISOString(),
      speakerMode: row.speakerMode,
      timing: row.timing,
      durationSeconds: row.durationSeconds,
      utteranceCount: row.utteranceCount,
      filename: payload?.filename ?? null,
      textAvailable: Boolean(payload),
      callSessionLinked: Boolean(row.callSessionId),
      contact: row.contactId ? { id: row.contactId, name: names.contacts.get(row.contactId) ?? "Unnamed" } : null,
      contactMatch: row.contactMatch,
      agent: row.agentId ? { id: row.agentId, name: names.agents.get(row.agentId) ?? "Unnamed" } : null,
    },
    utterances,
    disclaimer: DISCLAIMER,
  };
  if (!score) return { ...base, score: null, criteria: [], dnc: [], reviews: [], previousScores: [] };

  const [effMap, findingRows, reviewRows, resolutionRows] = await Promise.all([
    computeEffective(db, orgId, [{ id: score.id, transcriptId: row.id }]),
    db
      .select()
      .from(callScoreFindingsTable)
      .where(and(eq(callScoreFindingsTable.orgId, orgId), eq(callScoreFindingsTable.scoreId, score.id)))
      .orderBy(asc(callScoreFindingsTable.utteranceIndex), asc(callScoreFindingsTable.startOffset)),
    db
      .select()
      .from(callScoreReviewsTable)
      .where(and(eq(callScoreReviewsTable.orgId, orgId), eq(callScoreReviewsTable.scoreId, score.id), eq(callScoreReviewsTable.kind, "override")))
      .orderBy(asc(callScoreReviewsTable.createdAt), asc(callScoreReviewsTable.id)),
    db
      .select()
      .from(callScoreReviewsTable)
      .where(and(eq(callScoreReviewsTable.orgId, orgId), eq(callScoreReviewsTable.transcriptId, row.id), eq(callScoreReviewsTable.kind, "dnc_resolution"))),
  ]);
  const eff = effMap.get(score.id)!;
  const rubric = rubricFor(score.rubricId);
  const rubricMatches = rubric && rubric.version === score.rubricVersion ? rubric : null;

  const reviewerIds = [...new Set([...reviewRows, ...resolutionRows].map((r) => r.reviewerUserId).filter((x): x is string => Boolean(x)))];
  const reviewers = new Map<string, string>();
  if (reviewerIds.length) {
    const us = await db
      .select({ id: usersTable.id, name: usersTable.fullName })
      .from(usersTable)
      .where(and(eq(usersTable.orgId, orgId), inArray(usersTable.id, reviewerIds)));
    for (const u of us) reviewers.set(u.id, u.name);
  }

  // Criteria, in rubric order, with each piece of evidence.
  const groups = new Map<string, typeof findingRows>();
  for (const f of findingRows) {
    if (f.kind === "dnc") continue;
    (groups.get(f.criterionId) ?? groups.set(f.criterionId, []).get(f.criterionId)!).push(f);
  }
  const order = rubricMatches?.criteria.map((c) => c.id) ?? [];
  const ids = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.localeCompare(b);
  });
  const latestNote = new Map<string, { note: string | null; reviewerName: string | null; reviewerRole: string | null; at: string }>();
  for (const r of reviewRows) {
    if (!r.criterionId) continue;
    if (r.verdict === "revert") latestNote.delete(r.criterionId);
    else
      latestNote.set(r.criterionId, {
        note: open<{ note: string }>(r.noteEncrypted)?.note ?? null,
        reviewerName: r.reviewerUserId ? (reviewers.get(r.reviewerUserId) ?? null) : null,
        reviewerRole: r.reviewerRole,
        at: r.createdAt.toISOString(),
      });
  }
  const criteria = ids.map((id) => {
    const rows = groups.get(id)!;
    const first = rows[0]!;
    const meta = rubricMatches?.criteria.find((c) => c.id === id);
    const p0 = open<EvidencePayload>(first.evidenceEncrypted);
    const override = eff.overrides.get(id);
    const status: CriterionStatus = override && override.verdict !== "revert" ? override.verdict : (first.verdict as CriterionStatus);
    return {
      criterionId: id,
      name: first.criterionName,
      kind: first.kind,
      severity: first.severity,
      sectionId: meta?.sectionId ?? null,
      description: meta?.description ?? null,
      citation: meta?.citation ?? null,
      points: first.maxPoints,
      status,
      autoStatus: first.verdict as CriterionStatus,
      source: first.source,
      rationale: p0?.rationale ?? "",
      coaching: p0?.coaching ?? null,
      evidence: rows
        .filter((r) => r.utteranceIndex !== null)
        .map((r) => {
          const p = open<EvidencePayload>(r.evidenceEncrypted);
          return {
            findingId: r.id,
            utteranceIndex: r.utteranceIndex,
            endUtteranceIndex: r.endUtteranceIndex,
            startOffset: r.startOffset,
            endOffset: r.endOffset,
            startSeconds: r.startSeconds,
            speaker: roleLabel(r.speaker) as Role,
            quote: p?.quote ?? null,
            componentId: p?.componentId ?? null,
          };
        }),
      human: override && override.verdict !== "revert" ? { verdict: override.verdict, fraction: override.fraction ?? null, ...(latestNote.get(id) ?? { note: null, reviewerName: null, reviewerRole: null, at: override.at }) } : null,
    };
  });

  const resolutionByFingerprint = new Map(resolutionRows.map((r) => [r.fingerprint ?? "", r]));
  const dnc = findingRows
    .filter((f) => f.kind === "dnc")
    .map((f) => {
      const p = open<EvidencePayload>(f.evidenceEncrypted);
      const res = resolutionByFingerprint.get(f.fingerprint);
      return {
        findingId: f.id,
        criterionId: DNC_CRITERION_ID,
        fingerprint: f.fingerprint,
        utteranceIndex: f.utteranceIndex,
        startOffset: f.startOffset,
        endOffset: f.endOffset,
        startSeconds: f.startSeconds,
        speaker: roleLabel(f.speaker) as Role,
        quote: p?.quote ?? null,
        status: res ? (res.verdict === "opt_out_added" ? "opt_out_added" : "dismissed") : "open",
        resolution: res
          ? {
              action: res.verdict === "opt_out_added" ? "add_opt_out" : "dismiss",
              note: open<{ note: string }>(res.noteEncrypted)?.note ?? null,
              reviewerName: res.reviewerUserId ? (reviewers.get(res.reviewerUserId) ?? null) : null,
              at: res.createdAt.toISOString(),
            }
          : null,
      };
    });

  return {
    ...base,
    score: {
      id: score.id,
      createdAt: score.createdAt.toISOString(),
      rubric: {
        id: score.rubricId,
        version: score.rubricVersion,
        name: rubric?.name ?? score.rubricId,
        passThreshold: rubric?.passThreshold ?? null,
        currentVersion: rubric?.version ?? null,
      },
      method: score.method,
      ai: { status: score.aiStatus, model: score.aiModel, error: score.aiError },
      speakerMode: score.speakerMode,
      auto: {
        score: eff.auto.score,
        compliance: score.complianceStatus,
        criticalFailures: eff.auto.criticalFailures,
        needsReview: eff.auto.needsReview,
      },
      effective: {
        score: eff.effective.score,
        compliance: eff.effective.compliance,
        criticalFailures: eff.effective.criticalFailures,
        needsReview: eff.effective.needsReview,
        openDnc: eff.openDnc,
        meetsStandard: rubric ? meetsStandard(rubric, eff.effective) : null,
      },
    },
    criteria,
    dnc,
    reviews: reviewRows.map((r) => ({
      id: r.id,
      criterionId: r.criterionId,
      verdict: r.verdict,
      note: open<{ note: string }>(r.noteEncrypted)?.note ?? null,
      reviewerName: r.reviewerUserId ? (reviewers.get(r.reviewerUserId) ?? null) : null,
      reviewerRole: r.reviewerRole,
      at: r.createdAt.toISOString(),
    })),
    previousScores: allScores
      .filter((s) => s.id !== score.id)
      .map((s) => ({ id: s.id, createdAt: s.createdAt.toISOString(), score: s.score, compliance: s.compliance, rubricId: s.rubricId, rubricVersion: s.rubricVersion })),
  };
}

// keep the table import used for type inference in this module
export type CallTranscriptRow = typeof callTranscriptsTable.$inferSelect;
