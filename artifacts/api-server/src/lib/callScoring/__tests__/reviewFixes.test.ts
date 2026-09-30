/**
 * Regression tests for the PR review findings: speaker safety in parsing and
 * merging, deadlines, negated-only hits, ordering (scope of appointment),
 * agent-only needs analysis, late component evidence, seven-digit redaction,
 * and linear-time assembly of effective results.
 */
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../parse";
import { redactPHI } from "../redact";
import { detectDncRequests } from "../dnc";
import { runRules } from "../rules";
import { runScoring } from "../engine";
import { aiCriteria, type AiReviewer } from "../aiReviewer";
import { medicareRubric } from "../rubrics";
import type { AiJudgement } from "../score";
import type { CriterionResult, ParsedTranscript } from "../types";
import { tx, utt } from "./fixtures";

const byId = (r: { criteria: CriterionResult[] }) => Object.fromEntries(r.criteria.map((c) => [c.criterionId, c]));

function reviewerWith(make: (id: string) => AiJudgement | null): AiReviewer {
  return {
    name: "fake",
    async review() {
      return { criteria: aiCriteria(medicareRubric).flatMap((c) => make(c.id) ?? []) };
    },
  };
}
const judged = (id: string, status: AiJudgement["status"], evidence: AiJudgement["evidence"] = []): AiJudgement => ({
  criterionId: id,
  status,
  scorePercent: status === "pass" ? 100 : 0,
  rationale: "Because.",
  evidence,
  coaching: null,
});

describe("parser: explicit roles and untagged cues", () => {
  it("keeps each JSON turn's explicit role even when the speaker label is generic", () => {
    const t = parseTranscript(
      JSON.stringify([
        { speaker: "Speaker 1", role: "agent", text: "Thanks for calling, how can I help you today?" },
        { speaker: "Speaker 1", role: "client", text: "Please stop calling me." },
        { speaker: "Speaker 1", text: "Something with no role at all." },
      ]),
      { filename: "c.json" },
    );
    expect(t.utterances.map((u) => u.role)).toEqual(["agent", "client", "unknown"]);
    // The client's request is therefore still seen by the detector.
    expect(detectDncRequests(t)).toHaveLength(1);
  });

  it("does not let an inferred label map turn a client turn into agent speech", () => {
    const t = parseTranscript(
      JSON.stringify([
        { speaker: "spk_0", role: "agent", text: "Hello, this is a call about your plan options." },
        { speaker: "spk_0", role: "client", text: "Take me off your list." },
      ]),
      { filename: "c.json" },
    );
    expect(t.utterances[1]!.role).toBe("client");
    expect(detectDncRequests(t)).toHaveLength(1);
  });

  it("treats an untagged VTT cue as unknown, not as the previous cue's speaker", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Agent: Thanks for calling today.

2
00:00:05.000 --> 00:00:07.000
Please stop calling me.`;
    const t = parseTranscript(vtt, { filename: "x.vtt" });
    expect(t.utterances.map((u) => u.role)).toEqual(["agent", "unknown"]);
    // Unknown speech is still checked by the do-not-contact detector.
    expect(detectDncRequests(t)).toHaveLength(1);
  });
});

describe("captions: untagged cues are never merged", () => {
  it("keeps two adjacent untagged cues as two utterances and still finds the request", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Thanks for calling today.

2
00:00:03.200 --> 00:00:05.000
Please stop calling me.`;
    const t = parseTranscript(vtt, { filename: "x.vtt" });
    expect(t.utterances).toHaveLength(2);
    expect(t.utterances.map((u) => u.role)).toEqual(["unknown", "unknown"]);
    expect(t.utterances[0]!.text).toBe("Thanks for calling today.");
    expect(t.utterances[1]!.text).toBe("Please stop calling me.");
    expect(detectDncRequests(t)).toHaveLength(1);
  });

  it("still merges consecutive cues that carry the same explicit speaker tag", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Agent: Thanks for calling

2
00:00:03.200 --> 00:00:05.000
Agent: today.`;
    const t = parseTranscript(vtt, { filename: "x.vtt" });
    expect(t.utterances).toHaveLength(1);
    expect(t.utterances[0]!.role).toBe("agent");
  });
});

describe("redaction", () => {
  it("masks seven-digit local numbers and keeps 1-800-MEDICARE", () => {
    const out = redactPHI("Call me at 555-0123 or 555 0123, or read 1-800-MEDICARE and 1-800-633-4227.");
    expect(out).not.toContain("0123");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("1-800-MEDICARE");
    expect(out).toContain("1-800-633-4227");
  });
});

describe("unknown speakers never earn agent credit", () => {
  const disclaimer =
    "We do not offer every plan available in your area. We represent 7 organizations which offer 42 products. Contact Medicare.gov or 1-800-MEDICARE.";

  it("a required disclosure found only in unlabelled speech needs review (it may have been the client)", async () => {
    const r = await runScoring({ rubric: medicareRubric, transcript: tx([utt(0, 5, "unknown", disclaimer)]), ai: "off" });
    const c = byId(r).tpmo_disclaimer!;
    expect(c.status).toBe("needs_review");
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(r.totals.criticalFailures).not.toContain("tpmo_disclaimer");
    expect(r.totals.compliance).not.toBe("pass");
  });

  it("the same words from a labelled agent still pass", async () => {
    const t = tx([utt(0, 5, "agent", disclaimer), utt(1, 12, "client", "Okay.")]);
    const r = await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" });
    expect(byId(r).tpmo_disclaimer!.status).toBe("pass");
  });

  it("AI evidence from an unlabelled speaker does not satisfy an agent criterion", async () => {
    const t = tx([utt(0, 5, "unknown", "Let me explain how the plan works and what each benefit covers for you.")]);
    const reviewer = reviewerWith((id) =>
      id === "plan_explanation" ? judged(id, "pass", [{ utteranceId: 0, quote: "explain how the plan works and what each benefit covers" }]) : null,
    );
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).plan_explanation!.status).toBe("needs_review");
  });

  it("AI evidence quoting the CLIENT does not satisfy an agent criterion", async () => {
    const t = tx([utt(0, 5, "agent", "Hello there."), utt(1, 9, "client", "Explain how the plan works and what each benefit covers please.")]);
    const reviewer = reviewerWith((id) =>
      id === "plan_explanation" ? judged(id, "pass", [{ utteranceId: 1, quote: "Explain how the plan works and what each benefit covers" }]) : null,
    );
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).plan_explanation!.status).toBe("needs_review");
  });

  it("a rule hit in unlabelled speech plus an AI 'fail' still goes to a person", async () => {
    const t = tx([utt(0, 5, "unknown", "Honestly this is the best plan out there for you.")]);
    const reviewer = reviewerWith((id) =>
      id === "no_superlatives" ? judged(id, "fail", [{ utteranceId: 0, quote: "this is the best plan out there for you" }]) : null,
    );
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).no_superlatives!.status).toBe("needs_review");
    expect(byId(r).no_superlatives!.evidence.length).toBeGreaterThan(0);
  });
});

describe("negated-only rule hits", () => {
  const t = tx([
    utt(0, 5, "agent", "Thank you for calling."),
    utt(1, 9, "agent", "I would never say that this is the best plan out there."),
    utt(2, 14, "client", "Okay."),
  ]);

  it("the rule sees it as negated only", () => {
    const f = runRules(medicareRubric, t).find((x) => x.criterionId === "no_superlatives")!;
    expect(f.evidence.length).toBeGreaterThan(0);
    expect(f.negatedOnly).toBe(true);
  });

  it("an AI 'fail' with no verifiable quote does not turn it into a failure", async () => {
    const reviewer = reviewerWith((id) => (id === "no_superlatives" ? judged(id, "fail", [{ utteranceId: 1, quote: "words that were never said here" }]) : null));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).no_superlatives!.status).toBe("needs_review");
  });

  it("an AI 'fail' that quotes real words is still honoured", async () => {
    const reviewer = reviewerWith((id) =>
      id === "no_superlatives" ? judged(id, "fail", [{ utteranceId: 1, quote: "I would never say that this is the best plan out there" }]) : null,
    );
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).no_superlatives!.status).toBe("fail");
  });
});

describe("deadlines are enforced exactly", () => {
  const paraphrase = "The carriers I work with are only some of them, and the government website lists every other option, so please check it.";
  const quote = "the government website lists every other option so please check it";

  it("AI evidence a few seconds after the 60s limit does not pass a recorded call", async () => {
    const t = tx([utt(0, 3, "agent", "Hello and thanks for calling."), utt(1, 63, "agent", paraphrase)]);
    const reviewer = reviewerWith((id) => (id === "tpmo_disclaimer" ? judged(id, "pass", [{ utteranceId: 1, quote }]) : null));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).tpmo_disclaimer!.status).toBe("needs_review");
    expect(byId(r).tpmo_disclaimer!.rationale).toMatch(/after the 60s limit/);
  });

  it("with estimated timing, late AI evidence goes to a person instead of passing", async () => {
    const filler = Array.from({ length: 6 }, (_, i) => utt(i, i * 20, "agent", `Filler sentence number ${i} about nothing at all in particular here.`));
    const t = tx([...filler, utt(6, 130, "agent", paraphrase)], { timing: "estimated" });
    const reviewer = reviewerWith((id) => (id === "tpmo_disclaimer" ? judged(id, "pass", [{ utteranceId: 6, quote }]) : null));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).tpmo_disclaimer!.status).toBe("needs_review");
  });

  it("AI evidence inside the window is accepted", async () => {
    const t = tx([utt(0, 20, "agent", paraphrase)]);
    const reviewer = reviewerWith((id) => (id === "tpmo_disclaimer" ? judged(id, "pass", [{ utteranceId: 0, quote }]) : null));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).tpmo_disclaimer!.status).toBe("pass");
  });
});

describe("late component evidence is kept for the reviewer", () => {
  it("a disclaimer said only after the deadline still shows where it was said", async () => {
    const t = tx([
      utt(0, 5, "agent", "Hi, thanks for calling."),
      utt(1, 90, "agent", "We do not offer every plan available in your area. We represent 3 carriers. Call Medicare.gov for all options."),
    ]);
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).tpmo_disclaimer!;
    expect(c.status).toBe("fail");
    expect(c.evidence.length).toBeGreaterThanOrEqual(1);
    for (const e of c.evidence) {
      expect(e.quote.length).toBeGreaterThan(3);
      expect(e.startSec).toBe(90);
      expect(e.endOffset).toBeGreaterThan(e.startOffset);
    }
  });

  it("shows the late pieces next to the timely ones", async () => {
    const t = tx([
      utt(0, 5, "agent", "We do not offer every plan available in your area."),
      utt(1, 95, "agent", "Please call Medicare.gov for every option."),
    ]);
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).tpmo_disclaimer!;
    expect(c.status).not.toBe("pass");
    expect(c.evidence.map((e) => e.startSec).sort((a, b) => a - b)).toEqual([5, 95]);
  });
});

describe("scope of appointment must come before plan-specific discussion", () => {
  const soa = "Before we go on I need to confirm the scope of appointment, is it okay to discuss Medicare Advantage plans?";
  const planTalk = "This plan has a zero dollar premium and a low copay.";
  const base = [utt(0, 2, "agent", "Thanks for calling, this is Dana."), utt(9, 3, "client", "Hi.")];

  it("passes when it comes first", async () => {
    const t = tx([...base, utt(2, 10, "agent", soa), utt(3, 20, "agent", planTalk)].map((u, i) => ({ ...u, id: i })));
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).scope_of_appointment!;
    expect(c.status).toBe("pass");
  });

  it("a mention only after plans were presented does not pass", async () => {
    const t = tx([...base, utt(2, 10, "agent", planTalk), utt(3, 20, "agent", soa)].map((u, i) => ({ ...u, id: i })));
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).scope_of_appointment!;
    expect(c.status).toBe("needs_review");
    expect(c.evidence[0]!.quote.toLowerCase()).toContain("scope of appointment");
    expect(c.rationale).toMatch(/after the agent had started discussing specific plans/);
  });

  it("an AI 'pass' cannot clear a late-only mention", async () => {
    const t = tx([...base, utt(2, 10, "agent", planTalk), utt(3, 20, "agent", soa)].map((u, i) => ({ ...u, id: i })));
    const reviewer = reviewerWith((id) =>
      id === "scope_of_appointment" ? judged(id, "pass", [{ utteranceId: 3, quote: "I need to confirm the scope of appointment" }]) : null,
    );
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, reviewer })).scope_of_appointment!;
    expect(c.status).toBe("needs_review");
  });

  it("no mention at all while plans are discussed still fails", async () => {
    const t = tx([...base, utt(2, 10, "agent", planTalk)].map((u, i) => ({ ...u, id: i })));
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).scope_of_appointment!;
    expect(c.status).toBe("fail");
  });
});

describe("scope of appointment: benign openers do not set the ordering limit", () => {
  const soa = "Before we go on I need to confirm the scope of appointment, is it okay to discuss Medicare Advantage plans?";
  const openers = [
    "Our plan is to walk through your options together.",
    "Are you interested in a Humana product today?",
    "The premium is not something we set, the carriers do.",
    "There is a zero dollar premium option out there.",
    "Plans that have great coverage are what we look for.",
  ];
  for (const opener of openers) {
    it(`passes when "${opener}" comes before a valid scope of appointment`, async () => {
      const t = tx(
        [utt(0, 2, "agent", "Thanks for calling, this is Dana."), utt(1, 6, "agent", opener), utt(2, 12, "agent", soa), utt(3, 20, "client", "Yes.")].map((x, i) => ({ ...x, id: i })),
      );
      const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).scope_of_appointment!;
      expect(c.status).toBe("pass");
    });
  }

  const pitches = [
    "The Humana Gold Plus plan has a zero dollar premium.",
    "This plan has a low copay for specialists.",
    "The premium is zero dollars and the deductible is zero.",
    "That plan comes with a zero dollar copay for primary care.",
  ];
  for (const pitch of pitches) {
    it(`a real pitch ("${pitch}") before the scope of appointment still needs review`, async () => {
      const t = tx(
        [utt(0, 2, "agent", "Thanks for calling, this is Dana."), utt(1, 8, "agent", pitch), utt(2, 16, "agent", soa)].map((x, i) => ({ ...x, id: i })),
      );
      const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).scope_of_appointment!;
      expect(c.status).toBe("needs_review");
    });
  }
});

describe("needs analysis is the agent's work", () => {
  const client = [
    "My doctors are Dr Patel and a specialist.",
    "I take three prescriptions from the pharmacy.",
    "My current coverage is original medicare.",
    "My budget is small, the premium matters.",
    "I might have surgery at the hospital.",
  ];

  it("client statements do not earn the agent's score", async () => {
    const t = tx([
      utt(0, 1, "agent", "Thanks for calling."),
      ...client.map((c, i) => utt(i + 1, 10 + i * 6, "client", c)),
    ]);
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).needs_analysis!;
    expect(c.status).toBe("fail");
    expect(c.componentsFound ?? []).toHaveLength(0);
  });

  it("with no agent label the words are only found in unknown speech and go to a person", async () => {
    const t = tx(client.map((c, i) => utt(i, 10 + i * 6, "unknown", c)));
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).needs_analysis!;
    expect(c.status).toBe("needs_review");
  });
});

describe("partly labelled transcripts: unknown turns still count as unverified", () => {
  it("a prohibited phrase in an unattributed turn goes to a person, even though the agent is labelled", async () => {
    const t = tx([
      utt(0, 2, "agent", "Thanks for calling, how can I help?"),
      utt(1, 8, "unknown", "Hi, I'm calling from Medicare about your plan."),
      utt(2, 14, "client", "Okay."),
    ]);
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).no_government_affiliation!;
    expect(c.status).toBe("needs_review");
    expect(c.evidence[0]!.quote.toLowerCase()).toContain("calling from medicare");
  });

  it("an identified agent's own violation still fails", async () => {
    const t = tx([utt(0, 2, "agent", "Hi, I'm calling from Medicare about your plan."), utt(1, 8, "unknown", "Okay.")]);
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).no_government_affiliation!;
    expect(c.status).toBe("fail");
  });

  it("a disclosure found only in an unattributed turn is needs review, not a pass", async () => {
    const t = tx([
      utt(0, 2, "agent", "Thanks for calling."),
      utt(1, 8, "unknown", "We do not offer every plan available in your area. We represent 7 organizations which offer 42 products. Call Medicare.gov."),
    ]);
    const c = byId(await runScoring({ rubric: medicareRubric, transcript: t, ai: "off" })).tpmo_disclaimer!;
    expect(c.status).toBe("needs_review");
  });
});

describe("plain text: an unlabelled line is an unknown turn", () => {
  it("does not turn a client's line after an agent turn into agent speech", () => {
    const t = parseTranscript("Agent: Thanks for calling today.\nStop calling me.", { filename: "c.txt" });
    expect(t.utterances.map((u) => u.role)).toEqual(["agent", "unknown"]);
    expect(detectDncRequests(t)).toHaveLength(1);
  });
});

describe("phrases never join across other turns or long gaps", () => {
  it("'we do not' at 5s and 'offer every plan' at 90s do not form one phrase", async () => {
    const t = tx([
      utt(0, 5, "agent", "We do not"),
      utt(1, 20, "client", "What?"),
      utt(2, 90, "agent", "offer every plan available in your area."),
    ]);
    const f = runRules(medicareRubric, t).find((x) => x.criterionId === "tpmo_disclaimer")!;
    expect(f.componentsFound).not.toContain("not_every_plan");
  });

  it("an intervening client turn breaks the phrase even with no time gap", async () => {
    const t = tx([
      utt(0, 5, "agent", "We do not offer"),
      utt(1, 9, "client", "Hm."),
      utt(2, 10, "agent", "every plan available in your area."),
    ]);
    const f = runRules(medicareRubric, t).find((x) => x.criterionId === "tpmo_disclaimer")!;
    expect(f.componentsFound).not.toContain("not_every_plan");
  });

  it("consecutive turns close in time still join (a disclosure split across segments)", () => {
    const t = tx([
      utt(0, 5, "agent", "We do not offer every plan"),
      utt(1, 10, "agent", "available in your area."),
    ]);
    const f = runRules(medicareRubric, t).find((x) => x.criterionId === "tpmo_disclaimer")!;
    expect(f.componentsFound).toContain("not_every_plan");
  });
});

describe("an AI 'not applicable' on a critical item needs a person", () => {
  it("keeps the critical AI-only item at needs review and the call out of 'pass'", async () => {
    const t = tx([utt(0, 2, "agent", "Thanks for calling."), utt(1, 6, "client", "Hi.")]);
    const reviewer = reviewerWith((id) => (id === "informed_enrollment" ? { ...judged(id, "na"), scorePercent: 0 } : null));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).informed_enrollment!.status).toBe("needs_review");
    expect(r.totals.needsReview).toContain("informed_enrollment");
    expect(r.totals.compliance).not.toBe("pass");
  });

  it("a non-critical AI 'not applicable' is still accepted", async () => {
    const t = tx([utt(0, 2, "agent", "Thanks for calling."), utt(1, 6, "client", "Hi.")]);
    const reviewer = reviewerWith((id) => (id === "objection_handling" ? judged(id, "na") : null));
    const r = await runScoring({ rubric: medicareRubric, transcript: t, reviewer });
    expect(byId(r).objection_handling!.status).toBe("na");
  });
});

describe("do-not-contact detector: channel", () => {
  const at = (text: string) => detectDncRequests(tx([utt(0, 1, "agent", "Hello."), utt(1, 6, "client", text)]))[0];
  it("labels explicit email requests as email and explicit phone requests as phone", () => {
    for (const t of ["Please stop emailing me.", "No more emails please.", "Remove my email from your list.", "Please opt out of your emails."]) {
      expect(at(t), t).toMatchObject({ channel: "email", channelAssumed: false });
    }
    for (const t of ["Stop calling me.", "Please stop texting me.", "Stop calling and emailing me."]) {
      expect(at(t), t).toMatchObject({ channel: "phone", channelAssumed: false });
    }
  });

  it("classifies unsubscribe / opt-out wording as email, but flags it as assumed so the reviewer chooses", () => {
    for (const t of ["Please unsubscribe me from your list.", "Just opt me out.", "Unsubscribe."]) {
      expect(at(t), t).toMatchObject({ channel: "email", channelAssumed: true });
    }
  });

  it("a phone word in the same sentence makes an unsubscribe / opt-out a phone request", () => {
    expect(at("Unsubscribe me, I am tired of the calls.")).toMatchObject({ channel: "phone", channelAssumed: false });
    expect(at("Opt me out of the texts.")).toMatchObject({ channel: "phone", channelAssumed: false });
  });

  it("a bare 'do not contact me' stays a phone request and is marked assumed (never dropped)", () => {
    expect(at("Do not contact me again.")).toMatchObject({ channel: "phone", channelAssumed: true });
  });
});

// Keep the type import used (a ParsedTranscript helper for readers of this file).
export type _Parsed = ParsedTranscript;
