/**
 * Human review layered on top of the immutable automatic result.
 *
 * A reviewer can grade anything the automatic scorer left for review and
 * override anything it decided. Overrides are stored as an append-only history
 * (call_score_reviews); the stored automatic result is NEVER modified, so the
 * original grade, the human grade and who changed it are always visible side by
 * side. The "effective" result is computed here, on read, from the two.
 */
import type { CriterionResult, CriterionStatus, ReviewedStatus, Rubric, ScoreTotals } from "./types";
import { summarize } from "./score";

export interface OverrideRecord {
  criterionId: string;
  verdict: ReviewedStatus | "revert";
  /** 0..1 credit for "partial" (defaults to 0.5). */
  fraction?: number | null;
  reviewerUserId: string | null;
  note: string;
  at: string;
}

export interface EffectiveCriterion extends CriterionResult {
  /** The automatic grade, untouched, when a human changed it. */
  auto?: { status: CriterionStatus; fraction: number; rationale: string };
  human?: { verdict: ReviewedStatus; reviewerUserId: string | null; note: string; at: string };
}

export function overrideFraction(verdict: ReviewedStatus, fraction?: number | null): number {
  if (verdict === "pass") return 1;
  if (verdict === "fail" || verdict === "na") return 0;
  return Math.min(0.9, Math.max(0.1, fraction ?? 0.5));
}

/** Latest decision per criterion wins; a "revert" removes the override. History must be oldest first. */
export function effectiveOverrides(history: OverrideRecord[]): Map<string, OverrideRecord> {
  const latest = new Map<string, OverrideRecord>();
  for (const r of history) {
    if (r.verdict === "revert") latest.delete(r.criterionId);
    else latest.set(r.criterionId, r);
  }
  return latest;
}

export function applyOverrides(
  auto: CriterionResult[],
  overrides: Map<string, OverrideRecord>,
): EffectiveCriterion[] {
  return auto.map((c) => {
    const o = overrides.get(c.criterionId);
    if (!o || o.verdict === "revert") return c;
    const fraction = overrideFraction(o.verdict, o.fraction);
    const counted = o.verdict !== "na";
    return {
      ...c,
      status: o.verdict,
      fraction: counted ? fraction : 0,
      earned: counted ? Math.round(c.maxPoints * fraction * 10) / 10 : 0,
      auto: { status: c.status, fraction: c.fraction, rationale: c.rationale },
      human: { verdict: o.verdict, reviewerUserId: o.reviewerUserId, note: o.note, at: o.at },
    };
  });
}

/** The reviewed view of a call: automatic grades with human overrides applied and re-totalled. */
export function effectiveResult(
  rubric: Rubric,
  auto: CriterionResult[],
  overrides: Map<string, OverrideRecord>,
  unresolvedDnc: number,
): { criteria: EffectiveCriterion[]; totals: ScoreTotals } {
  const criteria = applyOverrides(auto, overrides);
  return { criteria, totals: summarize(rubric, criteria, unresolvedDnc) };
}
