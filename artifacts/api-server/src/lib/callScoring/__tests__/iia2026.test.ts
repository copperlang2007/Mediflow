/**
 * IIA 2026 QA Compliance Scorecard: the rubric matches the 150-point
 * scorecard, and the engine applies its rules (N/A = full credit, auto-fail
 * items all-or-nothing, pass at 120 / 150 compared on points).
 */
import { describe, expect, it } from "vitest";
import { runScoring } from "../engine";
import { aiCriteria, type AiReviewer } from "../aiReviewer";
import { parseRubric } from "../rubricSchema";
import { iia2026Rubric, medicareRubric } from "../rubrics";
import { meetsStandard, summarize, type AiJudgement } from "../score";
import type { CriterionResult } from "../types";
import { tx, utt } from "./fixtures";

const byId = (r: { criteria: CriterionResult[] }) => Object.fromEntries(r.criteria.map((c) => [c.criterionId, c]));

/** Section subtotals exactly as printed on the scorecard, in order. */
const SECTION_POINTS = [8, 20, 3, 3, 15, 6, 10, 12, 7, 2, 13, 12, 2, 3, 2, 4, 2, 5, 21];
/** Items marked "Y" in the scorecard's Auto-Fail column. */
const AUTO_FAIL = [
  "1-2-recorded-line", "1-3-decision-maker", "2-1-tpmo-verbatim", "2-2-tpmo-timing", "2-5-not-affiliated",
  "5-1-soa-products", "5-2-soa-no-obligation", "5-4-soa-permission", "7-1-election-period", "7-2-valid-election-confirmed",
  "8-1-csnp-disclosure", "8-2-dsnp-disclosure", "9-1-plan-type-explained", "9-2-snp-reiterated", "11-1-pre-enrollment-disclosures",
  "12-1-recorded-consent", "12-2-enrollment-confirmation", "12-3-ma-not-supplement", "13-1-government-restated", "18-2-tpv",
  "19-1-no-misrepresentation", "19-2-no-pressure", "19-3-health-info-minimum", "19-4-no-inducements",
];

const graded = (id: string, status: CriterionResult["status"], points: number, fraction = status === "pass" ? 1 : 0): CriterionResult => ({
  criterionId: id,
  status,
  fraction,
  earned: status === "pass" || status === "partial" || status === "fail" ? points * fraction : 0,
  maxPoints: points,
  evidence: [],
  rationale: "",
  source: "rules",
});

describe("the rubric matches the scorecard", () => {
  it("is a valid rubric: 19 sections, 47 items, 150 points, section subtotals as printed", () => {
    expect(() => parseRubric(iia2026Rubric)).not.toThrow();
    expect(iia2026Rubric.sections).toHaveLength(19);
    expect(iia2026Rubric.criteria).toHaveLength(47);
    expect(iia2026Rubric.criteria.reduce((s, c) => s + c.points, 0)).toBe(150);
    const subtotals = iia2026Rubric.sections.map((s) => iia2026Rubric.criteria.filter((c) => c.sectionId === s.id).reduce((t, c) => t + c.points, 0));
    expect(subtotals).toEqual(SECTION_POINTS);
    expect(iia2026Rubric.passThreshold).toBe(80);
    expect(iia2026Rubric.naCredit).toBe("full");
  });

  it("makes exactly the scorecard's auto-fail items critical, all-or-nothing, with disposition wording", () => {
    const critical = iia2026Rubric.criteria.filter((c) => c.severity === "critical").map((c) => c.id);
    expect(critical.sort()).toEqual([...AUTO_FAIL].sort());
    for (const c of iia2026Rubric.criteria) {
      if (c.severity !== "critical") {
        expect(c.allOrNothing, c.id).toBeFalsy();
        continue;
      }
      expect(c.allOrNothing, c.id).toBe(true);
      expect(c.autoFailNote, c.id).toMatch(/^AUTOMATIC FAIL – NON-COMPLIANT: /);
    }
  });
});

describe("scorecard rules in the engine", () => {
  it("N/A earns full points under naCredit 'full' and is left out otherwise", () => {
    const criteria = [graded("a", "pass", 100), graded("b", "na", 50)];
    const rubric = { ...iia2026Rubric, criteria: [] };
    expect(summarize(rubric, criteria).points).toEqual({ earned: 150, possible: 150 });
    expect(summarize({ ...rubric, naCredit: undefined }, criteria).points).toEqual({ earned: 100, possible: 100 });
  });

  it("passes at 120 / 150 compared on points, not the rounded percentage", () => {
    const rubric = { ...iia2026Rubric, criteria: [] };
    const at = (earned: number) => summarize(rubric, [graded("a", "partial", 150, earned / 150)]);
    expect(at(119.4).score).toBe(80);
    expect(meetsStandard(rubric, at(119.4))).toBe(false);
    expect(meetsStandard(rubric, at(120))).toBe(true);
  });

  it("gives auto-fail items no partial credit and fails the call", async () => {
    // Only the TPMO "not every plan" element is said: partial for most rubrics, a fail here.
    const t = tx([
      utt(0, 1, "agent", "Hi, my name is Sam, a licensed insurance agent with InsureItAll, on a recorded line."),
      utt(1, 6, "agent", "We do not offer every plan available in your area."),
      utt(2, 10, "client", "Okay."),
    ]);
    const r = await runScoring({ rubric: iia2026Rubric, transcript: t, ai: "off" });
    const tpmo = byId(r)["2-1-tpmo-verbatim"]!;
    expect(tpmo.status).toBe("fail");
    expect(tpmo.earned).toBe(0);
    expect(r.totals.compliance).toBe("fail");
    expect(r.totals.criticalFailures).toContain("2-1-tpmo-verbatim");
    // A non-auto-fail item keeps partial credit: 2.3 found 0 of 3, 1.1 found all 3.
    expect(byId(r)["1-1-agent-identification"]!.status).toBe("pass");
  });

  it("credits a scripted opening by phrase rules", async () => {
    const t = tx([
      utt(0, 1, "agent", "Thank you for calling InsureItAll, my name is Dana Brooks and I'm a licensed insurance agent. I'm on a recorded line."),
      utt(1, 6, "agent", "Do you make your own healthcare decisions?"),
      utt(2, 9, "client", "Yes I do."),
      utt(3, 12, "agent", "We do not offer every plan available in your area. Currently we represent 7 organizations which offer 42 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program to get information on all of your options."),
      utt(4, 24, "agent", "We are not affiliated with Medicare or the federal government. What's the best number to call you back if we get disconnected? I do have your permission to call you back, correct?"),
      utt(5, 32, "client", "Yes."),
    ]);
    const r = await runScoring({ rubric: iia2026Rubric, transcript: t, ai: "off" });
    const by = byId(r);
    for (const id of ["1-1-agent-identification", "1-2-recorded-line", "1-3-decision-maker", "2-1-tpmo-verbatim", "2-2-tpmo-timing", "2-3-tpmo-all-options", "2-4-callback-permission", "2-5-not-affiliated"]) {
      expect(by[id]!.status, id).toBe("pass");
    }
  });

  it("never lets the AI alone take a critical item out: N/A goes to a person, with the AI's quotes kept", async () => {
    const t = tx([
      utt(0, 1, "agent", "This plan is a PPO plan, not a special needs plan, so there is no extra eligibility check."),
      utt(1, 6, "client", "Okay."),
    ]);
    const na = (id: string, quote: string | null): AiJudgement => ({
      criterionId: id,
      status: "na",
      scorePercent: 0,
      rationale: "Not a C-SNP.",
      evidence: quote ? [{ utteranceId: 0, quote }] : [],
      coaching: null,
    });
    const reviewer = (quote: string | null): AiReviewer => ({
      name: "fake",
      async review() {
        return { criteria: aiCriteria(iia2026Rubric).map((c) => (c.id === "8-1-csnp-disclosure" ? na(c.id, quote) : { ...na(c.id, null), status: "pass" as const })) };
      },
    });
    const withQuote = byId(await runScoring({ rubric: iia2026Rubric, transcript: t, ai: "auto", reviewer: reviewer("This plan is a PPO plan, not a special needs plan") }));
    expect(withQuote["8-1-csnp-disclosure"]!.status).toBe("needs_review");
    expect(withQuote["8-1-csnp-disclosure"]!.evidence[0]!.quote).toContain("PPO plan");
    // An unrelated (or injected) quote cannot clear it either.
    const unrelated = byId(await runScoring({ rubric: iia2026Rubric, transcript: t, ai: "auto", reviewer: reviewer(null) }));
    expect(unrelated["8-1-csnp-disclosure"]!.status).toBe("needs_review");
  });

  it("leaves the existing Medicare rubric's N/A and partial behaviour unchanged", () => {
    expect(medicareRubric.naCredit).toBeUndefined();
    expect(medicareRubric.criteria.some((c) => c.allOrNothing || c.conditional)).toBe(false);
  });
});
