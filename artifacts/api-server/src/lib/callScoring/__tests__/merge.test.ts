/**
 * Fail-closed merge policy: compliance is a gate, missing disclosures fail,
 * AI claims need verbatim evidence, and an unavailable AI never passes
 * judgment items silently.
 */
import { describe, expect, it } from "vitest";
import { runScoring } from "../engine";
import { aiCriteria, createAiReviewer, type AiReviewer } from "../aiReviewer";
import { medicareRubric } from "../rubrics";
import { meetsStandard, summarize, type AiJudgement } from "../score";
import type { CriterionResult, ParsedTranscript } from "../types";
import { sampleCall, tx, utt } from "./fixtures";

const byId = (r: { criteria: CriterionResult[] }) => Object.fromEntries(r.criteria.map((c) => [c.criterionId, c]));

function fakeReviewer(make: (ids: string[]) => AiJudgement[]): AiReviewer {
  return {
    name: "fake-reviewer",
    async review() {
      return { criteria: make(aiCriteria(medicareRubric).map((c) => c.id)) };
    },
  };
}

const pass = (id: string, evidence: AiJudgement["evidence"] = []): AiJudgement => ({
  criterionId: id,
  status: "pass",
  scorePercent: 100,
  rationale: "Done well.",
  evidence,
  coaching: null,
});

const bestPlanId = sampleCall.utterances.findIndex((u) => u.text.includes("best plan"));
const costId = sampleCall.utterances.findIndex((u) => u.text.startsWith("The premium is zero"));

describe("rules only (no AI reviewer)", () => {
  it("scores the sample call, catches its violations, and sends judgment items to review", async () => {
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, ai: "off" });
    const by = byId(r);
    expect(by.tpmo_disclaimer!.status).toBe("pass");
    expect(by.recording_notice!.status).toBe("pass");
    expect(by.scope_of_appointment!.status).toBe("pass");
    expect(by.no_superlatives!.status).toBe("fail");
    expect(by.no_pressure!.status).toBe("fail");
    expect(by.no_government_affiliation!.status).toBe("pass");
    expect(by.plan_explanation!.status).toBe("needs_review");
    expect(by.no_superlatives!.evidence[0]!.quote).toContain("best plan");
    expect(by.no_superlatives!.evidence).toHaveLength(1);
    // informed_enrollment is critical and ungraded -> the call needs review, never a silent pass.
    expect(r.totals.compliance).toBe("review");
    expect(r.ai.status).toBe("skipped");
  });

  it("fails compliance when a required critical disclosure has no evidence", async () => {
    const t = tx([utt(0, 2, "agent", "Hi this is Sam, let me tell you about a great plan."), utt(1, 8, "client", "Okay.")]);
    const r = await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" });
    expect(r.totals.compliance).toBe("fail");
    expect(r.totals.criticalFailures).toContain("tpmo_disclaimer");
    expect(byId(r).tpmo_disclaimer!.evidence).toHaveLength(0);
  });

  it("compliance is a gate, not an average: a strong score cannot outvote a failed critical item", async () => {
    const t = tx(sampleCall.utterances.filter((u) => !u.text.startsWith("We do not offer every plan")));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" });
    expect(byId(r).tpmo_disclaimer!.status).not.toBe("pass");
    expect(r.totals.compliance).toBe("fail");
    expect(r.totals.score).toBeGreaterThan(40);
    expect(meetsStandard(medicareRubric, r.totals)).toBe(false);
  });

  it("a hit in unlabelled speech goes to a person instead of failing the agent", async () => {
    const t = tx([utt(0, 5, "unknown", "Honestly this is the best plan out there.")]);
    const r = await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" });
    expect(byId(r).no_superlatives!.status).toBe("needs_review");
    expect(byId(r).no_superlatives!.rationale).toMatch(/no agent label/i);
  });

  it("a late disclaimer with RECORDED timing fails; with ESTIMATED timing a person decides", async () => {
    const utterances = [utt(0, 90, "agent", "We don't offer every plan in your area. We represent 3 carriers. Call Medicare.gov for all options.")];
    const recorded = await runScoring({ rubric: medicareRubric, transcript: tx(utterances), ai: "off" });
    expect(byId(recorded).tpmo_disclaimer!.status).toBe("fail");
    const estimated = await runScoring({ rubric: medicareRubric, transcript: tx(utterances, { timing: "estimated" }), ai: "off" });
    expect(byId(estimated).tpmo_disclaimer!.status).toBe("needs_review");
    expect(estimated.totals.criticalFailures).not.toContain("tpmo_disclaimer");
    expect(recorded.totals.criticalFailures).toContain("tpmo_disclaimer");
  });

  it("an unresolved possible do-not-contact request keeps compliance at review", () => {
    const criteria: CriterionResult[] = medicareRubric.criteria.map((c) => ({
      criterionId: c.id,
      status: "pass",
      fraction: 1,
      earned: c.points,
      maxPoints: c.points,
      evidence: [],
      rationale: "",
      source: "rules",
    }));
    expect(summarize(medicareRubric, criteria, 0).compliance).toBe("pass");
    expect(summarize(medicareRubric, criteria, 1).compliance).toBe("review");
  });
});

describe("with an AI reviewer", () => {
  it("verifies quotes and never lets the AI invent evidence", async () => {
    const reviewer = fakeReviewer((ids) =>
      ids.map((id): AiJudgement => {
        if (id === "no_superlatives") return { ...pass(id), rationale: "Context ok" };
        if (id === "no_government_affiliation")
          return { ...pass(id), status: "fail", scorePercent: 0, rationale: "Invented", evidence: [{ utteranceId: 3, quote: "I work for the government" }] };
        if (id === "informed_enrollment") return { ...pass(id), status: "na", scorePercent: 0, rationale: "No enrollment on this call." };
        return pass(id, [{ utteranceId: costId, quote: "the premium is zero dollars" }]);
      }),
    );
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer });
    const by = byId(r);
    expect(by.no_superlatives!.status).toBe("pass"); // non-critical flagged phrase the AI cleared
    expect(by.no_government_affiliation!.status).toBe("needs_review"); // fake quote -> human
    expect(by.plan_explanation!.status).toBe("pass");
    expect(by.plan_explanation!.evidence[0]!.utteranceId).toBe(costId);
    // A critical judgment item the AI marked N/A is still a valid N/A (judgment), not a required disclosure.
    expect(by.informed_enrollment!.status).toBe("na");
    expect(r.ai).toEqual({ status: "used", model: "fake-reviewer", error: null });
    expect(r.totals.compliance).toBe("review");
  });

  it("an AI that clears a flagged CRITICAL phrase sends it to human review", async () => {
    const t = tx([
      utt(0, 5, "agent", "Hi, I'm calling from Medicare about your plan."),
      utt(1, 9, "client", "Okay."),
    ]);
    const reviewer = fakeReviewer((ids) => ids.map((id) => pass(id, [{ utteranceId: 0, quote: "Hi I'm calling from Medicare about your plan" }])));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).no_government_affiliation!.status).toBe("needs_review");
    expect(byId(r).no_government_affiliation!.rationale).toMatch(/person must confirm/i);
    // and the words the rules flagged stay attached
    expect(byId(r).no_government_affiliation!.evidence[0]!.quote).toMatch(/calling from Medicare/i);
  });

  it("an AI 'pass' on a required disclosure without verifiable words goes to review, not pass", async () => {
    const t = tx([utt(0, 5, "agent", "Welcome, let me tell you about our plans."), utt(1, 9, "client", "Sure.")]);
    const reviewer = fakeReviewer((ids) => ids.map((id) => pass(id, [{ utteranceId: 0, quote: "we do not offer every plan available in your area" }])));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).tpmo_disclaimer!.status).toBe("needs_review");
    expect(r.totals.compliance).not.toBe("pass");
  });

  it("an AI 'not applicable' never quietly clears a CRITICAL required disclosure", async () => {
    const t = tx([utt(0, 5, "agent", "Welcome."), utt(1, 9, "client", "Hi.")]);
    const reviewer = fakeReviewer((ids) => ids.map((id) => ({ ...pass(id), status: "na" as const, rationale: "n/a" })));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).tpmo_disclaimer!.status).toBe("needs_review");
    expect(byId(r).recording_notice!.status).not.toBe("pass");
  });

  it("a judgment 'pass' with no verifiable quote is not a pass", async () => {
    const reviewer = fakeReviewer((ids) => ids.map((id) => pass(id, [])));
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer });
    expect(byId(r).plan_explanation!.status).toBe("needs_review");
    expect(byId(r).rapport!.status).toBe("needs_review");
  });

  it("ignores AI evidence quoted from the wrong speaker", async () => {
    const clientLine = sampleCall.utterances.findIndex((u) => u.role === "client" && u.text.includes("worried about my costs"));
    const reviewer = fakeReviewer((ids) =>
      ids.map((id) => (id === "plan_explanation" ? pass(id, [{ utteranceId: clientLine, quote: "I'm worried about my costs" }]) : pass(id))),
    );
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer });
    expect(byId(r).plan_explanation!.status).toBe("needs_review");
  });

  it("a hybrid AI 'fail' with an invented quote goes to review, not fail", async () => {
    const reviewer = fakeReviewer((ids) =>
      ids.map((id) => (id === "no_pressure" ? { ...pass(id), status: "fail" as const, scorePercent: 0, evidence: [{ utteranceId: bestPlanId, quote: "sign today or lose it forever" }] } : pass(id))),
    );
    const t = tx(sampleCall.utterances.filter((u) => !u.text.includes("lose your doctors")));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).no_pressure!.status).toBe("needs_review");
  });
});

describe("AI unavailable", () => {
  it("not configured: reports needs_setup and leaves judgment items needing review", async () => {
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer: null });
    expect(r.ai).toEqual({ status: "needs_setup", model: null, error: null });
    expect(byId(r).rapport!.status).toBe("needs_review");
    expect(byId(r).informed_enrollment!.status).toBe("needs_review");
    expect(r.totals.compliance).toBe("review");
  });

  it("errors: fails closed, keeps only a fixed message, never provider text", async () => {
    const reviewer: AiReviewer = {
      name: "broken",
      review: async () => {
        throw new Error("upstream said: patient Jane Roe MBI 1EG4-TE5-MK73");
      },
    };
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer });
    expect(r.ai.status).toBe("failed");
    expect(r.ai.error).toBe("The AI reviewer failed.");
    expect(JSON.stringify(r.ai)).not.toContain("Jane");
    expect(byId(r).rapport!.status).toBe("needs_review");
  });

  it("times out: fails closed", async () => {
    const reviewer: AiReviewer = { name: "slow", review: () => new Promise(() => undefined) };
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer, timeoutMs: 20 });
    expect(r.ai).toEqual({ status: "failed", model: null, error: "The AI reviewer timed out." });
    expect(byId(r).rapport!.status).toBe("needs_review");
  });

  it("malformed model output fails closed with a fixed message", async () => {
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "not json at all, sorry" } }] }) } } };
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer: createAiReviewer(client, "m") });
    expect(r.ai.status).toBe("failed");
    expect(r.ai.error).toBe("The AI reviewer returned output that could not be read.");
  });

  it("ai:'off' never calls a reviewer", async () => {
    let called = false;
    const reviewer: AiReviewer = { name: "x", review: async () => ((called = true), { criteria: [] }) };
    const r = await runScoring({ rubric: medicareRubric, transcript: sampleCall, reviewer, ai: "off" });
    expect(called).toBe(false);
    expect(r.ai.status).toBe("skipped");
  });
});

describe("transcript with no utterances is never scored as passing", () => {
  it("has nothing to cite, so required critical items fail", async () => {
    const empty: ParsedTranscript = tx([]);
    const r = await runScoring({ rubric: medicareRubric, transcript: empty, ai: "auto", reviewer: null });
    expect(r.totals.compliance).toBe("fail");
    expect(r.ai.status).toBe("skipped");
  });
});
