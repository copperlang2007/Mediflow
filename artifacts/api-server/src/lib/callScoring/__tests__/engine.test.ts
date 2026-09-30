/**
 * Engine tests, ported from myCALL's engine.test.ts and extended for
 * Mediflow: the phrase-rule engine (negation, time windows, speaker), the
 * normalizer with position mapping, evidence verification, and the rubric data.
 */
import { describe, expect, it } from "vitest";
import { runRules } from "../rules";
import { normalize, normalizeMapped } from "../text";
import { verifyEvidence, type AiJudgement } from "../score";
import { runScoring } from "../engine";
import { generalSalesRubric, medicareRubric, builtInRubrics } from "../rubrics";
import { parseRubric } from "../rubricSchema";
import { sampleCall, tx, utt } from "./fixtures";
import type { ParsedTranscript } from "../types";

const finding = (t: ParsedTranscript, id: string) => runRules(medicareRubric, t).find((f) => f.criterionId === id)!;

describe("normalize", () => {
  it("strips punctuation, apostrophes and case", () => {
    expect(normalize("We're NOT with Medicare.gov - call 1-800-MEDICARE!")).toBe("were not with medicare gov call 1 800 medicare");
  });

  it("maps every normalized character back to the original text", () => {
    const raw = "  Hello, I don't want it & you'll see!";
    const { norm, map } = normalizeMapped(raw);
    expect(norm).toBe("hello i dont want it and youll see");
    const at = norm.indexOf("dont");
    expect(raw.slice(map[at], map[at + 3] + 1)).toBe("don't");
  });
});

describe("rule engine", () => {
  it("finds a TPMO disclaimer split across utterances", () => {
    const t = tx([
      utt(0, 5, "agent", "We do not offer every plan available in your area. Currently we represent"),
      utt(1, 10, "agent", "five organizations which offer 30 products in your area."),
      utt(2, 16, "agent", "Please contact Medicare.gov or 1-800-MEDICARE for all your options."),
    ]);
    const f = finding(t, "tpmo_disclaimer");
    expect(f.satisfied).toBe(true);
    expect([...f.componentsFound].sort()).toEqual(["all_options", "not_every_plan", "represent_count"]);
  });

  it("records the exact words and where they sit", () => {
    const t = tx([utt(0, 5, "agent", "Honestly, this is the best plan out there.")]);
    const f = finding(t, "no_superlatives");
    const ev = f.evidence[0]!;
    expect(ev.quote).toBe("the best plan");
    expect("Honestly, this is the best plan out there.".slice(ev.startOffset, ev.endOffset)).toBe("the best plan");
    expect(ev.utteranceId).toBe(0);
    expect(ev.startSec).toBe(5);
  });

  it("time window: a disclaimer read after the first minute is late, not satisfied", () => {
    const t = tx([utt(0, 90, "agent", "We don't offer every plan in your area. We represent 3 carriers. Call Medicare.gov for all options.")]);
    const f = finding(t, "tpmo_disclaimer");
    expect(f.satisfied).toBe(false);
    expect(f.late).toBe(true);
  });

  it("time window: a disclaimer inside the window is satisfied", () => {
    const t = tx([utt(0, 58, "agent", "We don't offer every plan in your area. We represent 3 carriers. Call Medicare.gov for all options.")]);
    expect(finding(t, "tpmo_disclaimer").satisfied).toBe(true);
  });

  it("does not credit the client for agent disclosures", () => {
    const t = tx([utt(0, 5, "client", "This call is being recorded, right?"), utt(1, 9, "agent", "Yes.")]);
    expect(finding(t, "recording_notice").satisfied).toBe(false);
  });

  it("flags government affiliation but not selling Medicare plans", () => {
    const bad = tx([utt(0, 5, "agent", "Hi, I'm calling from Medicare about your benefits.")]);
    const ok = tx([utt(0, 5, "agent", "I'm with Medicare Advantage plans department at Sunrise, and Medicare.gov has more info.")]);
    expect(finding(bad, "no_government_affiliation").violated).toBe(true);
    expect(finding(ok, "no_government_affiliation").evidence).toHaveLength(0);
  });

  it("marks negated prohibited phrases as negated, not violated", () => {
    const t = tx([utt(0, 5, "agent", "I can't tell you it's the best plan for everyone.")]);
    const f = finding(t, "no_superlatives");
    expect(f.violated).toBe(false);
    expect(f.negatedOnly).toBe(true);
  });

  it("negation does not leak across sentences", () => {
    const t = tx([utt(0, 5, "agent", "I do not have that here. This is the best plan out there.")]);
    expect(finding(t, "no_superlatives").violated).toBe(true);
  });

  it("does not flag Medigap 'guaranteed issue'", () => {
    const t = tx([utt(0, 5, "agent", "In some states you have guaranteed issue rights for Medigap.")]);
    expect(finding(t, "no_guarantees").evidence).toHaveLength(0);
  });

  it("gives partial credit for needs analysis", () => {
    const t = tx([utt(0, 5, "agent", "Which doctors do you see and what prescriptions do you take? What's your budget?")]);
    const f = finding(t, "needs_analysis");
    expect([...f.componentsFound].sort()).toEqual(["budget", "doctors", "prescriptions"]);
    expect(f.satisfied).toBe(false);
  });

  it("with no agent label, searches unlabelled speech and says the speaker is unverified", () => {
    const t = tx([utt(0, 5, "unknown", "Honestly this is the best plan out there.")]);
    const f = finding(t, "no_superlatives");
    expect(f.violated).toBe(true);
    expect(f.speakerUnverified).toBe(true);
  });

  it("flags estimated timing when a time window applies", () => {
    const t = tx([utt(0, 5, "agent", "hello")], { timing: "estimated" });
    expect(finding(t, "tpmo_disclaimer").timingEstimated).toBe(true);
    expect(finding(t, "no_superlatives").timingEstimated).toBe(false);
  });
});

describe("evidence verification", () => {
  const byUtt = new Map(sampleCall.utterances.map((x) => [x.id, x]));
  const ai = (utteranceId: number, quote: string): AiJudgement => ({
    criterionId: "x",
    status: "pass",
    scorePercent: 100,
    rationale: "",
    evidence: [{ utteranceId, quote }],
    coaching: null,
  });
  const check = (utteranceId: number, quote: string) => verifyEvidence(ai(utteranceId, quote), byUtt).length;
  const bestId = sampleCall.utterances.findIndex((u) => u.text.includes("best plan"));
  const costId = sampleCall.utterances.findIndex((u) => u.text.startsWith("The premium is zero"));

  it("accepts verbatim quotes, ignoring case and punctuation, with ... skips", () => {
    expect(check(bestId, "honestly, this is the BEST plan out there")).toBe(1);
    expect(check(costId, "The premium is zero dollars ... maximum out of pocket")).toBe(1);
  });

  it("rejects reordered, stitched-together or too-short quotes", () => {
    expect(check(bestId, "your doctors lose you'll the best plan")).toBe(0);
    expect(check(bestId, "this is the best plan next year")).toBe(0);
    expect(check(bestId, "best")).toBe(0);
    expect(check(999, "anything")).toBe(0);
  });

  it("accepts quotes of redacted text the AI actually saw", () => {
    const one = new Map([[0, utt(0, 0, "client", "My number is 555-123-4567 okay")]]);
    expect(verifyEvidence(ai(0, "my number is [PHONE] okay"), one)).toHaveLength(1);
  });
});

describe("rubrics as data", () => {
  it("both built-in rubrics validate against the schema", () => {
    for (const r of builtInRubrics) expect(() => parseRubric(JSON.parse(JSON.stringify(r)))).not.toThrow();
  });

  it("keeps a citation on the critical Medicare rules", () => {
    for (const c of medicareRubric.criteria.filter((x) => x.severity === "critical" && x.kind !== "judgment")) {
      expect(c.citation, c.id).toBeTruthy();
    }
    expect(medicareRubric.criteria.find((c) => c.id === "tpmo_disclaimer")!.citation).toContain("422.2267(e)(41)");
  });

  it("does not score or extract health information", () => {
    const text = JSON.stringify(medicareRubric).toLowerCase();
    expect(text).not.toContain("health conditions");
    expect(medicareRubric.criteria.some((c) => c.id === "needs_analysis" && c.components?.some((k) => k.id === "conditions"))).toBe(false);
    expect("extract" in medicareRubric).toBe(false);
  });

  it("general rubric compiles and scores", async () => {
    const r = await runScoring({ rubric: generalSalesRubric, transcript: sampleCall, ai: "off" });
    expect(r.criteria).toHaveLength(generalSalesRubric.criteria.length);
  });
});
