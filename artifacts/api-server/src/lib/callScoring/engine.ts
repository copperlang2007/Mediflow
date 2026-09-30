/**
 * The scoring pipeline: rules -> do-not-contact detector -> optional AI ->
 * fail-closed merge. Pure of the database; persistence lives in store.ts.
 */
import type { AiStatus, CriterionResult, ParsedTranscript, Rubric, ScoreTotals } from "./types";
import { runRules, type RuleFinding } from "./rules";
import { detectDncRequests, type DncFinding } from "./dnc";
import { assembleCriteria, summarize, type AiReview } from "./score";
import { AiReviewError, aiCriteria, resolveAiReviewer, type AiReviewer } from "./aiReviewer";

export const AI_TIMEOUT_MS = 90_000;

export interface AiOutcome {
  status: AiStatus;
  model: string | null;
  /** A fixed, non-PHI message; never provider output. */
  error: string | null;
}

export interface ScoreRun {
  rubric: Rubric;
  findings: RuleFinding[];
  criteria: CriterionResult[];
  dnc: DncFinding[];
  totals: ScoreTotals;
  ai: AiOutcome;
}

export interface RunScoringOptions {
  rubric: Rubric;
  transcript: ParsedTranscript;
  /**
   * "auto" runs the AI step when the HIPAA-gated AI is configured; "off" never
   * calls AI (bulk import, or a caller who asked for rules only).
   */
  ai?: "auto" | "off";
  /** Injected in tests. undefined = resolve the real, gated reviewer; null = none configured. */
  reviewer?: AiReviewer | null;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiReviewError("The AI reviewer timed out.")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runScoring(opts: RunScoringOptions): Promise<ScoreRun> {
  const { rubric, transcript } = opts;
  const findings = runRules(rubric, transcript);
  const dnc = detectDncRequests(transcript);

  let review: AiReview | null = null;
  let ai: AiOutcome = { status: "skipped", model: null, error: null };
  const wantsAi = (opts.ai ?? "auto") === "auto" && aiCriteria(rubric).length > 0 && transcript.utterances.length > 0;
  if (wantsAi) {
    const reviewer = opts.reviewer !== undefined ? opts.reviewer : resolveAiReviewer();
    if (!reviewer) {
      ai = { status: "needs_setup", model: null, error: null };
    } else {
      try {
        review = await withTimeout(reviewer.review({ rubric, transcript, findings }), opts.timeoutMs ?? AI_TIMEOUT_MS);
        ai = { status: "used", model: reviewer.name, error: null };
      } catch (err) {
        // Fail closed: judgment items stay "needs review". Only our own fixed messages are kept.
        ai = {
          status: "failed",
          model: null,
          error: err instanceof AiReviewError ? err.message : "The AI reviewer failed.",
        };
      }
    }
  }

  const criteria = assembleCriteria({ rubric, transcript, findings, review });
  return { rubric, findings, criteria, dnc, totals: summarize(rubric, criteria, dnc.length), ai };
}
