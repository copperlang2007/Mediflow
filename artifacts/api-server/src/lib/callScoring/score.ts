/**
 * Scoring and the fail-closed merge policy.
 *
 * Deterministic rules run first; an AI reviewer (when the org's HIPAA-gated AI
 * is configured) may grade judgment items and confirm paraphrases. The merge
 * is conservative on purpose:
 *
 *  - compliance is a GATE, not an average: any failed critical item fails the
 *    call whatever the score; an unreviewed critical item leaves it "review";
 *  - a required disclosure with no evidence FAILS;
 *  - an AI claim only counts if its quoted words appear verbatim in the
 *    transcript (checked against the raw and the redacted text); otherwise the
 *    item goes to a human;
 *  - an AI that clears a phrase the rules flagged on a CRITICAL item sends it
 *    to a human instead of passing silently;
 *  - AI unavailable or erroring => judgment items are "needs review", never
 *    silently passed;
 *  - when speaker labels are missing, a hit cannot be pinned on the agent, so
 *    it goes to a human instead of failing the agent.
 *
 * None of this is a compliance certification or legal advice. It assists a
 * human reviewer.
 */
import type {
  Criterion,
  CriterionResult,
  CriterionStatus,
  Evidence,
  ParsedTranscript,
  ResultSource,
  Rubric,
  ScoreTotals,
  Utterance,
} from "./types";
import type { RuleFinding } from "./rules";
import { redactPHI } from "./redact";
import { isBefore } from "./rules";
import { formatClock, normalize } from "./text";

/** One criterion as graded by the AI reviewer (already schema-validated). */
export interface AiJudgement {
  criterionId: string;
  status: "pass" | "partial" | "fail" | "na";
  /** 0-100, used for partial credit. */
  scorePercent: number;
  rationale: string;
  evidence: Array<{ utteranceId: number; quote: string }>;
  coaching: string | null;
}

export interface AiReview {
  criteria: AiJudgement[];
}

/**
 * Keep only AI evidence whose quote really appears, word for word and in
 * order, in the cited utterance. "..." in a quote may skip words between
 * fragments. The quote is checked against both the raw and the PHI-redacted
 * text (the AI only ever saw the redacted form).
 */
export function verifyEvidence(ai: AiJudgement, byUtt: Map<number, Utterance>): Evidence[] {
  const out: Evidence[] = [];
  for (const e of ai.evidence) {
    const u = byUtt.get(e.utteranceId);
    if (!u) continue;
    const fragments = e.quote
      .split(/\.{3}|…/)
      .map(normalize)
      .filter(Boolean);
    const quoteWords = fragments.join(" ").split(" ").filter(Boolean).length;
    const utteranceWords = normalize(u.text).split(" ").filter(Boolean).length;
    // A one-word "quote" proves nothing unless the utterance itself is that short.
    if (!fragments.length || quoteWords < Math.min(3, utteranceWords)) continue;
    const texts = [normalize(u.text), normalize(redactPHI(u.text))];
    if (texts.some((t) => containsInOrder(t, fragments))) {
      out.push({
        utteranceId: u.id,
        endUtteranceId: u.id,
        startOffset: 0,
        endOffset: u.text.length,
        startSec: u.startSec,
        endSec: u.endSec,
        role: u.role,
        quote: u.text,
      });
    }
  }
  return dedupe(out);
}

function containsInOrder(text: string, fragments: string[]): boolean {
  const padded = ` ${text} `;
  let from = 0;
  for (const f of fragments) {
    const at = padded.indexOf(` ${f} `, from);
    if (at < 0) return false;
    from = at + f.length + 1;
  }
  return true;
}

function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const k = `${e.utteranceId}|${e.startOffset}|${e.componentId ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function aiFraction(ai: AiJudgement): number {
  if (ai.status === "pass") return 1;
  if (ai.status === "fail") return 0;
  const p = Number.isFinite(ai.scorePercent) ? ai.scorePercent / 100 : 0.5;
  return Math.min(0.9, Math.max(0.1, p));
}

function componentFraction(c: Criterion, f: RuleFinding): number {
  if (!c.components?.length) return f.satisfied ? 1 : 0;
  const need = c.minComponents ?? c.components.length;
  return Math.min(1, f.componentsFound.length / need);
}

function result(
  c: Criterion,
  status: CriterionStatus,
  fraction: number,
  evidence: Evidence[],
  rationale: string,
  source: ResultSource,
  extra: Partial<CriterionResult> = {},
): CriterionResult {
  const counted = status === "pass" || status === "partial" || status === "fail";
  const f = counted ? Math.min(1, Math.max(0, fraction)) : 0;
  const failing = status === "fail" || status === "partial" || status === "needs_review";
  return {
    criterionId: c.id,
    status,
    fraction: f,
    earned: counted ? Math.round(c.points * f * 10) / 10 : 0,
    maxPoints: c.points,
    evidence,
    rationale,
    source,
    ...(failing && c.hint ? { coaching: c.hint } : {}),
    ...extra,
  };
}

/**
 * AI evidence must come from the IDENTIFIED speaker the criterion is about
 * (unless the rubric says "any"). Words from an unlabelled speaker could be the
 * client's, so they never count for an agent criterion: the item goes to a
 * person instead.
 */
function fromExpectedSpeaker(c: Criterion, evidence: Evidence[]): Evidence[] {
  const want = c.speaker ?? "agent";
  if (want === "any") return evidence;
  return evidence.filter((e) => e.role === want);
}

export interface MergeInput {
  rubric: Rubric;
  transcript: ParsedTranscript;
  findings: RuleFinding[];
  /** Null when no AI review happened (not configured, skipped, or it failed). */
  review: AiReview | null;
}

/** Grade every criterion in the rubric. */
export function assembleCriteria({ rubric, transcript, findings, review }: MergeInput): CriterionResult[] {
  const byUtt = new Map(transcript.utterances.map((u) => [u.id, u]));
  const ruleById = new Map(findings.map((f) => [f.criterionId, f]));
  const aiById = new Map((review?.criteria ?? []).map((c) => [c.criterionId, c]));
  const aiAvailable = review !== null;
  return rubric.criteria.map((c) => judge(c, ruleById.get(c.id), aiById.get(c.id), aiAvailable, byUtt));
}

function judge(
  c: Criterion,
  f: RuleFinding | undefined,
  ai: AiJudgement | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  if (c.kind === "judgment" || c.evaluator === "llm" || !f) return judgeByAi(c, ai, aiAvailable, byUtt);
  return c.kind === "prohibited"
    ? judgeProhibited(c, f, ai, aiAvailable, byUtt)
    : judgeRequired(c, f, ai, aiAvailable, byUtt);
}

function judgeByAi(
  c: Criterion,
  ai: AiJudgement | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  if (!ai) {
    return result(
      c,
      "needs_review",
      0,
      [],
      aiAvailable
        ? "The AI reviewer did not grade this item. A person needs to."
        : "Needs a person or the AI reviewer: AI review is not set up or did not run.",
      "llm",
    );
  }
  if (ai.status === "na") {
    // An AI alone cannot take a critical item out of the score and the gate.
    if (c.severity === "critical") {
      return result(
        c,
        "needs_review",
        0,
        [],
        `The AI reviewer marked this not applicable. A person must confirm that before a critical item is left out. ${ai.rationale}`,
        "llm",
      );
    }
    return result(c, "na", 0, [], ai.rationale, "llm");
  }
  const verified = verifyEvidence(ai, byUtt);
  const evidence = fromExpectedSpeaker(c, verified);
  if (!evidence.length) {
    const wrongSpeaker = verified.length > 0;
    return result(
      c,
      "needs_review",
      0,
      wrongSpeaker ? verified : [],
      wrongSpeaker
        ? `The AI reviewer's quotes are in the transcript, but not from a speaker identified as the ${c.speaker ?? "agent"} (the labels are missing or say otherwise), so a person needs to confirm who said it. ${ai.rationale}`
        : `The AI reviewer judged "${ai.status}" but did not quote words that can be found in the transcript, so a person needs to check. ${ai.rationale}`,
      "llm",
    );
  }
  return result(c, ai.status, aiFraction(ai), evidence, ai.rationale, "llm", {
    ...(ai.coaching ? { coaching: ai.coaching } : {}),
  });
}

function judgeRequired(
  c: Criterion,
  f: RuleFinding,
  ai: AiJudgement | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  const extra = { componentsFound: f.componentsFound };
  const window = c.withinSeconds !== undefined ? ` within ${c.withinSeconds}s` : "";

  if (f.outOfOrder) {
    // Mentioned, but only after plan-specific discussion began: it cannot count
    // as "before", and a keyword alone must not clear a critical item.
    return result(
      c,
      "needs_review",
      0,
      f.evidence,
      `This was mentioned only after the agent had started discussing specific plans, so it is not shown to have come first. A person needs to check the order.`,
      "rules",
      extra,
    );
  }

  if (f.satisfied) {
    const at = f.evidence[0] ? ` at ${formatClock(f.evidence[0].startSec)}` : "";
    if (f.speakerUnverified) {
      // Found only in unlabelled speech: it may have been the client, so it is
      // not credit until a person confirms who said it.
      return result(
        c,
        "needs_review",
        0,
        f.evidence,
        `The words were found${at}, but the file has no agent label, so it is not confirmed the agent said them. A person needs to confirm who spoke.`,
        "rules",
        extra,
      );
    }
    return result(c, "pass", 1, f.evidence, `Found by phrase rules${at}.`, "rules", extra);
  }

  // Said, but only after the window closed. With estimated timing that is not
  // provable, so a person decides; with recorded timing it fails.
  if (f.late && f.timingEstimated) {
    return result(
      c,
      "needs_review",
      0,
      f.evidence,
      `Found only after the ${c.withinSeconds}s limit, but this transcript has no timestamps (timing is estimated from word counts), so a person needs to check.`,
      "rules",
      extra,
    );
  }

  const rulesFraction = f.late ? 0 : componentFraction(c, f);
  const rulesStatus: CriterionStatus = rulesFraction > 0 ? "partial" : "fail";
  const rulesRationale = f.late
    ? `Said too late: only found after the ${c.withinSeconds}s limit.`
    : f.componentsTotal
      ? `Found ${f.componentsFound.length} of ${f.componentsTotal} required elements${window}.`
      : `No evidence found${window}.`;

  if (c.evaluator === "rules" || !ai) {
    const note = c.evaluator === "hybrid" && !aiAvailable ? " No AI paraphrase check ran, so this fails closed." : "";
    return result(c, rulesStatus, rulesFraction, f.evidence, rulesRationale + note, "rules", extra);
  }

  if (ai.status === "na") {
    // An AI must not quietly clear a critical disclosure.
    if (c.severity === "critical") {
      return result(
        c,
        "needs_review",
        0,
        f.evidence,
        `${rulesRationale} The AI reviewer marked this not applicable: a person must confirm before a critical item is cleared. ${ai.rationale}`,
        "rules+llm",
        extra,
      );
    }
    return result(c, "na", 0, [], ai.rationale, "rules+llm", extra);
  }

  const aiSpoken = fromExpectedSpeaker(c, verifyEvidence(ai, byUtt));
  // The stated deadline applies in both timing modes; no slack is added.
  const aiEvidence = aiSpoken.filter(
    (e) => (c.withinSeconds === undefined || e.startSec <= c.withinSeconds) && (!f.precedeLimit || isBefore(e, f.precedeLimit)),
  );
  if (ai.status === "pass" || ai.status === "partial") {
    if (!aiEvidence.length) {
      const late = aiSpoken.length > 0;
      return result(
        c,
        "needs_review",
        0,
        late ? dedupe([...f.evidence, ...aiSpoken]) : f.evidence,
        late
          ? `AI reviewer's quoted words come ${f.precedeLimit ? "after plan-specific discussion began" : `after the ${c.withinSeconds}s limit${f.timingEstimated ? " (timing is estimated from word counts)" : ""}`}, so a person needs to check. ${ai.rationale}`
          : `AI reviewer judged "${ai.status}" but its quoted words could not be verified in the transcript${window}. ${ai.rationale}`,
        "rules+llm",
        extra,
      );
    }
    const fraction = Math.max(rulesFraction, aiFraction(ai));
    return result(
      c,
      fraction >= 1 ? "pass" : "partial",
      fraction,
      dedupe([...f.evidence, ...aiEvidence]),
      `Paraphrase confirmed by the AI reviewer. ${ai.rationale}`,
      "rules+llm",
      { ...extra, ...(ai.coaching ? { coaching: ai.coaching } : {}) },
    );
  }
  return result(c, rulesStatus, rulesFraction, dedupe([...f.evidence, ...aiEvidence]), `${rulesRationale} ${ai.rationale}`, "rules+llm", {
    ...extra,
    ...(ai.coaching ? { coaching: ai.coaching } : c.hint ? { coaching: c.hint } : {}),
  });
}

function judgeProhibited(
  c: Criterion,
  f: RuleFinding,
  ai: AiJudgement | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  const flagged = f.evidence.length > 0;
  const aiEvidence = ai ? fromExpectedSpeaker(c, verifyEvidence(ai, byUtt)) : [];

  if (c.evaluator === "rules" || !ai) {
    if (f.violated) {
      if (f.speakerUnverified) {
        return result(
          c,
          "needs_review",
          0,
          f.evidence,
          "Flagged phrasing found in speech with no agent label, so it cannot be tied to the agent. A person needs to check who said it.",
          "rules",
        );
      }
      return result(c, "fail", 0, f.evidence, `Prohibited phrasing found (${f.evidence.length}x).`, "rules");
    }
    if (f.negatedOnly) {
      return result(c, "needs_review", 0, f.evidence, "Flagged phrasing appears negated. Confirm the context.", "rules");
    }
    const note = c.evaluator === "hybrid" && !aiAvailable ? " (phrase rules only; no AI review ran)" : "";
    return result(c, "pass", 1, [], `No prohibited phrasing found${note}.`, "rules");
  }

  if (ai.status === "fail" || ai.status === "partial") {
    if (f.negatedOnly && !aiEvidence.length) {
      return result(c, "needs_review", 0, f.evidence, "The phrase appears only negated, and the AI cited no verifiable words for a violation. A person needs to check.", "rules+llm");
    }
    const evidence = dedupe([...f.evidence, ...aiEvidence]);
    if (!evidence.length) {
      return result(
        c,
        "needs_review",
        0,
        [],
        `AI reviewer reported a violation but cited no words that can be verified. ${ai.rationale}`,
        "llm",
      );
    }
    if (f.speakerUnverified) {
      return result(c, "needs_review", 0, evidence, `${ai.rationale} (No agent label in the file, so a person must confirm who said it.)`, "rules+llm");
    }
    // Flagged words the rules read as negated are not a violation by themselves:
    // a fail then needs words the AI quoted that were verified in the transcript.
    if (!f.violated && !aiEvidence.length) {
      return result(
        c,
        "needs_review",
        0,
        evidence,
        `AI reviewer reported a violation, but the only flagged words look negated and it cited no verifiable words of its own. A person needs to check. ${ai.rationale}`,
        "rules+llm",
      );
    }
    return result(c, "fail", 0, evidence, ai.rationale, flagged ? "rules+llm" : "llm", {
      ...(ai.coaching ? { coaching: ai.coaching } : c.hint ? { coaching: c.hint } : {}),
    });
  }

  if (flagged) {
    // The AI cleared a phrase the rules flagged. Critical items still get a human look.
    if (c.severity === "critical") {
      return result(
        c,
        "needs_review",
        0,
        f.evidence,
        `Phrase rules flagged this; the AI reviewer judged it acceptable: ${ai.rationale} A person must confirm before a critical item is cleared.`,
        "rules+llm",
      );
    }
    return result(c, "pass", 1, f.evidence, `Flagged phrase judged acceptable in context: ${ai.rationale}`, "rules+llm");
  }
  return result(c, "pass", 1, [], ai.rationale || "No violation found.", "rules+llm");
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/**
 * Score and compliance gate from graded criteria. Shared by the automatic
 * result and by the human-reviewed view, so both use identical maths.
 * `unresolvedDnc` counts possible do-not-contact requests nobody has resolved
 * yet: while any exist the call cannot read "pass" (it reads "review").
 */
export function summarize(rubric: Rubric, criteria: CriterionResult[], unresolvedDnc = 0): ScoreTotals {
  const critical = new Set(rubric.criteria.filter((c) => c.severity === "critical").map((c) => c.id));
  return summarizeWith(critical, criteria, unresolvedDnc);
}

/** Same maths, with the critical criterion ids supplied (used when re-reading a stored score). */
export function summarizeWith(critical: Set<string>, criteria: CriterionResult[], unresolvedDnc = 0): ScoreTotals {
  const counted = criteria.filter((r) => r.status === "pass" || r.status === "partial" || r.status === "fail");
  const max = counted.reduce((s, r) => s + r.maxPoints, 0);
  const earned = counted.reduce((s, r) => s + r.earned, 0);
  const score = max > 0 ? Math.round((earned / max) * 100) : 0;

  const criticalFailures = criteria
    .filter((r) => critical.has(r.criterionId) && (r.status === "fail" || r.status === "partial"))
    .map((r) => r.criterionId);
  const needsReview = criteria.filter((r) => r.status === "needs_review").map((r) => r.criterionId);
  const compliance = criticalFailures.length
    ? "fail"
    : needsReview.some((id) => critical.has(id)) || unresolvedDnc > 0
      ? "review"
      : "pass";
  return { score, compliance, criticalFailures, needsReview };
}

/** True when the call is clean AND meets the rubric's quality bar. */
export function meetsStandard(rubric: Rubric, totals: ScoreTotals): boolean {
  return totals.compliance === "pass" && totals.score >= rubric.passThreshold;
}
