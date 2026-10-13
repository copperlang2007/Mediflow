import { describe, expect, it } from "vitest";
import type { Utterance } from "../../lib/callScoring/types";
import { applyAgentSpeaker, speakerSummary } from "../../lib/callScoring/speakerRoles";
import { detectDncRequests } from "../../lib/callScoring/dnc";
import type { ParsedTranscript } from "../../lib/callScoring/types";

describe("do-not-contact flags after a reviewer names the agent", () => {
  const stop = (role: Utterance["role"]): Utterance => ({ id: 3, startSec: 9, endSec: 12, speaker: "Speaker 1", role, text: "Please stop calling me." });
  const call = (role: Utterance["role"], speakersAssigned: boolean): ParsedTranscript => ({
    utterances: [stop(role)],
    speakerMode: "partial",
    timing: "recorded",
    durationSec: 12,
    format: "json",
    speakersAssigned,
  });

  it("gives a client turn a new fingerprint, so an earlier dismissal made while the speaker was unknown cannot cover it", () => {
    const before = detectDncRequests(call("unknown", false))[0]!;
    const after = detectDncRequests(call("client", true))[0]!;
    expect(before.fingerprint).toBe(`dnc:3:${before.startOffset}`);
    expect(after.fingerprint).toBe(`dnc:3:${after.startOffset}:client`);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("leaves fingerprints alone for files that named their own speakers", () => {
    expect(detectDncRequests(call("client", false))[0]!.fingerprint).toMatch(/^dnc:3:\d+$/);
  });

  it("finds nothing in an empty call", () => {
    expect(detectDncRequests({ ...call("client", true), utterances: [] })).toEqual([]);
  });

  it("never flags what the agent said, even after an assignment", () => {
    expect(detectDncRequests(call("agent", true))).toEqual([]);
  });

  it("leaves unknown turns alone even after an assignment", () => {
    expect(detectDncRequests(call("unknown", true))[0]!.fingerprint).toMatch(/^dnc:3:\d+$/);
  });
});

function u(id: number, speaker: string, role: Utterance["role"] = "unknown"): Utterance {
  return { id, startSec: id * 5, endSec: id * 5 + 4, speaker, role, text: `line ${id}` };
}

describe("speakerSummary", () => {
  it("lists numbered voice labels with turn counts, in order of first appearance", () => {
    const s = speakerSummary([u(0, "Speaker 2"), u(1, "Speaker 1"), u(2, "Speaker 2")]);
    expect(s.speakers).toEqual([
      { label: "Speaker 2", turns: 2, role: "unknown" },
      { label: "Speaker 1", turns: 1, role: "unknown" },
    ]);
    expect(s.assignable).toBe(true);
  });

  it("is not assignable when the voices were never told apart (plain 'Speaker')", () => {
    expect(speakerSummary([u(0, "Speaker"), u(1, "Speaker")]).assignable).toBe(false);
  });

  it("is not assignable, and lists nobody, for an empty transcript", () => {
    expect(speakerSummary([])).toEqual({ speakers: [], assignable: false });
  });

  it("is not assignable when the file already names the agent", () => {
    const s = speakerSummary([u(0, "Dana Brooks (Agent)", "agent"), u(1, "Customer", "client")]);
    expect(s.assignable).toBe(false);
    expect(s.speakers).toEqual([]);
  });

  it("reports the role a past choice gave each voice", () => {
    const s = speakerSummary([u(0, "Speaker 1", "agent"), u(1, "Speaker 2", "client")], { reassigning: true });
    expect(s.speakers.map((x) => x.role)).toEqual(["agent", "client"]);
    expect(s.assignable).toBe(true);
  });

  it("trusts roles the file itself supplied, even on numbered voices", () => {
    const fromFile = [u(0, "Speaker 1", "agent"), u(1, "Speaker 2", "client")];
    expect(speakerSummary(fromFile).assignable).toBe(false);
    expect(applyAgentSpeaker(fromFile, "Speaker 2").ok).toBe(false);
  });

  it("still protects a file's own named agent when re-choosing", () => {
    const mixed = [u(0, "Dana (Agent)", "agent"), u(1, "Speaker 1", "client")];
    expect(speakerSummary(mixed, { reassigning: true }).assignable).toBe(false);
  });
});

describe("applyAgentSpeaker", () => {
  it("makes the chosen voice the agent and the other voice the client", () => {
    const out = applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker 2"), u(2, "Speaker 1")], "Speaker 2");
    if (!out.ok) throw new Error(out.message);
    expect(out.utterances.map((x) => x.role)).toEqual(["client", "agent", "client"]);
    expect(out.speakerMode).toBe("labelled");
    expect(out.utterances.map((x) => x.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
  });

  it("can be corrected: choosing the other voice swaps the roles", () => {
    const first = applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker 2")], "Speaker 1");
    if (!first.ok) throw new Error(first.message);
    const second = applyAgentSpeaker(first.utterances, "Speaker 2", { reassigning: true });
    if (!second.ok) throw new Error(second.message);
    expect(second.utterances.map((x) => x.role)).toEqual(["client", "agent"]);
  });

  it("leaves a third voice unknown rather than guessing it is the client", () => {
    const out = applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker 2"), u(2, "Speaker 3")], "Speaker 1");
    if (!out.ok) throw new Error(out.message);
    expect(out.utterances.map((x) => x.role)).toEqual(["agent", "unknown", "unknown"]);
    expect(out.speakerMode).toBe("partial");
  });

  it("with only one voice found, the client stays unknown", () => {
    const out = applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker 1")], "Speaker 1");
    if (!out.ok) throw new Error(out.message);
    expect(out.speakerMode).toBe("partial");
  });

  it("does not touch turns that were not told apart", () => {
    const out = applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker"), u(2, "Speaker 2")], "Speaker 1");
    if (!out.ok) throw new Error(out.message);
    expect(out.utterances.map((x) => x.role)).toEqual(["agent", "unknown", "client"]);
  });

  it("refuses a voice that is not in the call", () => {
    const out = applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker 2")], "Speaker 9");
    expect(out.ok).toBe(false);
  });

  it("refuses a transcript whose file already names the agent", () => {
    const out = applyAgentSpeaker([u(0, "Dana (Agent)", "agent"), u(1, "Speaker 1")], "Speaker 1");
    expect(out.ok).toBe(false);
  });

  it("refuses when voices were never told apart", () => {
    expect(applyAgentSpeaker([u(0, "Speaker"), u(1, "Speaker")], "Speaker").ok).toBe(false);
  });

  it("refuses an empty transcript", () => {
    expect(applyAgentSpeaker([], "Speaker 1").ok).toBe(false);
  });

  it("treats a blank choice as not in the call", () => {
    expect(applyAgentSpeaker([u(0, "Speaker 1"), u(1, "Speaker 2")], "").ok).toBe(false);
  });

  it("works on a one-turn call", () => {
    const out = applyAgentSpeaker([u(0, "Speaker 1")], "Speaker 1");
    if (!out.ok) throw new Error(out.message);
    expect(out.utterances.map((x) => x.role)).toEqual(["agent"]);
    expect(out.speakerMode).toBe("partial");
  });

  it("does not change the input", () => {
    const input = [u(0, "Speaker 1"), u(1, "Speaker 2")];
    applyAgentSpeaker(input, "Speaker 1");
    expect(input.map((x) => x.role)).toEqual(["unknown", "unknown"]);
  });
});
