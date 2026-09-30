/**
 * Transcript parsing (TXT / VTT / SRT / JSON) and speaker-label honesty.
 */
import { describe, expect, it } from "vitest";
import { PARSE_LIMITS, TranscriptParseError, parseTranscript, roleFromLabel } from "../parse";

describe("transcript parsing", () => {
  it("parses a Zoom-style VTT: explicit labels set roles, other names stay unknown", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Dana Brooks (Agent): Thanks for calling, my name is Dana, I'm a licensed agent.

2
00:00:04.500 --> 00:00:06.000
Pat Lee: Hi Dana.

3
00:00:06.100 --> 00:00:09.000
Dana Brooks (Agent): This call is being recorded.`;
    const t = parseTranscript(vtt, { filename: "meeting.vtt" });
    expect(t.format).toBe("vtt");
    expect(t.utterances).toHaveLength(3);
    expect(t.utterances.map((u) => u.role)).toEqual(["agent", "unknown", "agent"]);
    expect(t.speakerMode).toBe("partial");
    expect(t.timing).toBe("recorded");
    expect(t.utterances[2]!.startSec).toBe(6.1);
  });

  it("parses SRT with <v> voice tags", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
<v Agent>Hello there.</v>

2
00:00:03,500 --> 00:00:05,000
<v Customer>Hi.</v>`;
    const t = parseTranscript(srt, { filename: "call.srt" });
    expect(t.utterances.map((u) => u.role)).toEqual(["agent", "client"]);
    expect(t.speakerMode).toBe("labelled");
  });

  it("parses plain text with Agent/Customer labels and timestamps", () => {
    const t = parseTranscript("[00:05] Customer: I have a question\n[00:09] Agent: Sure, how can I help?\nThis continues.", {
      filename: "call.txt",
    });
    // A line with no label of its own is an unknown turn, never folded into the agent's turn.
    expect(t.utterances.map((u) => u.role)).toEqual(["client", "agent", "unknown"]);
    expect(t.utterances[1]!.text).toBe("Sure, how can I help?");
    expect(t.utterances[2]!.text).toBe("This continues.");
    expect(t.utterances[1]!.startSec).toBe(9);
  });

  it("treats every speaker as unknown when there are no labels, and says so", () => {
    const t = parseTranscript("Hello thanks for calling\nHi I have a question\nSure go ahead");
    expect(t.utterances).toHaveLength(3);
    expect(t.utterances.every((u) => u.role === "unknown")).toBe(true);
    expect(t.speakerMode).toBe("unlabelled");
    expect(t.timing).toBe("estimated");
  });

  it("does not guess roles from generic labels like Speaker 1 / Speaker 2", () => {
    const t = parseTranscript("Speaker 1: Thank you for calling, this is a licensed agent.\nSpeaker 2: Hello.");
    expect(t.speakerMode).toBe("unlabelled");
    expect(t.utterances.map((u) => u.role)).toEqual(["unknown", "unknown"]);
    expect(t.utterances.map((u) => u.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("parses JSON in several common shapes", () => {
    const a = parseTranscript(JSON.stringify([{ speaker: "Agent", text: "hi", start: 0, end: 1 }, { speaker: "Customer", text: "yo", start: 1, end: 2 }]), { filename: "a.json" });
    expect(a.speakerMode).toBe("labelled");
    expect(a.timing).toBe("recorded");
    const b = parseTranscript(JSON.stringify({ segments: [{ text: "hello there", start: 0, end: 2 }] }), { filename: "b.json" });
    expect(b.utterances).toHaveLength(1);
    expect(b.speakerMode).toBe("unlabelled");
    const c = parseTranscript(
      JSON.stringify({ results: { channels: [{}, {}], utterances: [{ start: 0, end: 2, channel: 1, transcript: "hello?" }, { start: 2, end: 5, channel: 0, transcript: "Hi there" }] } }),
      { filename: "c.json" },
    );
    expect(c.utterances.map((u) => u.speaker)).toEqual(["ch1", "ch0"]);
    const d = parseTranscript(JSON.stringify({ utterances: [{ role: "agent", text: "x y z" }, { role: "customer", text: "q r s" }] }), { filename: "d.json" });
    expect(d.utterances.map((u) => u.role)).toEqual(["agent", "client"]);
    expect(d.timing).toBe("estimated");
  });

  it("estimates timing from word counts when the file has no timestamps", () => {
    const t = parseTranscript("Agent: one two three four five six seven eight\nCustomer: ok");
    expect(t.timing).toBe("estimated");
    expect(t.utterances[1]!.startSec).toBeGreaterThan(t.utterances[0]!.startSec);
  });

  it("rejects empty, binary, oversized and unrecognised input with safe messages", () => {
    expect(() => parseTranscript("   ")).toThrow(TranscriptParseError);
    expect(() => parseTranscript("abc\u0000def")).toThrow(/text transcript/);
    expect(() => parseTranscript("x".repeat(PARSE_LIMITS.maxChars + 1))).toThrow(/too large/);
    expect(() => parseTranscript("{not json", { filename: "x.json" })).toThrow(/could not be read/);
    expect(() => parseTranscript(JSON.stringify({ hello: "world" }), { filename: "x.json" })).toThrow(/Unrecognized JSON/);
    expect(() => parseTranscript(JSON.stringify([{ nothing: 1 }]), { filename: "x.json" })).toThrow(/No speech/);
    try {
      parseTranscript("{secret client text", { filename: "x.json" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("roleFromLabel only trusts explicit role words", () => {
    expect(roleFromLabel("Agent")).toBe("agent");
    expect(roleFromLabel("Agent 2")).toBe("agent");
    expect(roleFromLabel("Dana Brooks (Rep)")).toBe("agent");
    expect(roleFromLabel("Dana Brooks (Sam)")).toBe("unknown");
    expect(roleFromLabel("Dana Brooks (Agent)")).toBe("agent");
    expect(roleFromLabel("Caller")).toBe("client");
    expect(roleFromLabel("Speaker 1")).toBe("unknown");
    expect(roleFromLabel("Pat")).toBe("unknown");
  });
});
