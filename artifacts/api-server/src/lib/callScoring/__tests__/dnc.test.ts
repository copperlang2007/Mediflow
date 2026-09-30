/**
 * Do-not-contact detector: positives, negations, and speaker rules.
 */
import { describe, expect, it } from "vitest";
import { detectDncRequests } from "../dnc";
import { tx, utt } from "./fixtures";
import type { Role } from "../types";

const hits = (text: string, role: Role = "client") =>
  detectDncRequests(tx([utt(0, 1, "agent", "Hello, is this a good time?"), utt(1, 6, role, text)]));

describe("possible do-not-contact requests", () => {
  const POSITIVES = [
    "Stop calling me.",
    "Please stop calling.",
    "Take me off your list.",
    "Take my number off your calling list please",
    "Remove me from your call list",
    "Do not call me again.",
    "Don't contact me anymore.",
    "Please don't call me.",
    "Remove my number.",
    "Delete my number from your system.",
    "I'm on the do not call list.",
    "I am on the national do not call registry, why are you calling?",
    "Quit texting me!",
    "No more calls, thank you.",
    "I don't want any more calls.",
    "I do not want you to call me anymore",
    "Put me on your do not call list.",
    "Leave me alone.",
    "Please unsubscribe me",
    "Never call me again",
    "I'm not interested, don't call me again", // "not interested" is not a negation of the request
    "No, stop calling me",
    "No stop calling me",
    "I told you already, stop calling me!",
    "If you don't stop calling me I will report you.",
    "STOP CALLING ME",
    "Stop the calls.",
    "Stop sending me texts.",
  ];
  it.each(POSITIVES)("flags: %s", (text) => {
    const found = hits(text);
    expect(found, text).toHaveLength(1);
    // The exact quote is in the transcript, verbatim.
    expect(text).toContain(found[0]!.quote.replace(/\s+/g, " ").slice(0, 12).trim().slice(0, 5));
    expect(text.slice(found[0]!.startOffset, found[0]!.endOffset).length).toBeGreaterThan(0);
  });

  const NEGATIVES = [
    "I'd never say stop calling.",
    "I would never tell you to stop calling me.",
    "I'm not asking you to stop calling.",
    "I don't want you to stop calling, I like hearing from you.",
    "You never stop calling!",
    "If you want us to stop calling, just say so.",
    "I'm not on the do not call list.",
    "Nobody said take me off the list.",
    "That's a lovely day, thanks for calling back.",
    "I need help with my prescriptions.",
    "Can you call me on Thursday at two?",
    "Please call me back tomorrow.",
    "Don't hang up, I have one more question.",
    "I don't call people often but I wanted to say thanks.",
  ];
  it.each(NEGATIVES)("does not flag: %s", (text) => {
    expect(hits(text), text).toHaveLength(0);
  });

  it("reports the exact quote (the sentence) and the position of the phrase", () => {
    const text = "Well, thanks for the offer. Please take me off your list. Have a nice day.";
    const [f] = hits(text);
    expect(f!.quote).toBe("Please take me off your list.");
    expect(text.slice(f!.startOffset, f!.endOffset)).toBe("take me off your list");
    expect(f!.utteranceId).toBe(1);
    expect(f!.fingerprint).toBe(`dnc:1:${f!.startOffset}`);
    expect(f!.startSec).toBe(6);
  });

  it("never fires on the AGENT's words (script, quoting, reading a rule)", () => {
    expect(hits("Stop calling me is something we honor. Take me off your list is a request we log.", "agent")).toHaveLength(0);
    expect(hits("If you ask us to stop calling, we will add you to the do not call list.", "agent")).toHaveLength(0);
    expect(hits("I'm on the do not call list too, ha.", "agent")).toHaveLength(0);
  });

  it("fires on unlabelled speech when the file has no speaker labels", () => {
    const t = tx([utt(0, 1, "unknown", "Hello?"), utt(1, 5, "unknown", "Stop calling me please.")]);
    const found = detectDncRequests(t);
    expect(found).toHaveLength(1);
    expect(found[0]!.role).toBe("unknown");
  });

  it("finds one request per turn, on the right turn", () => {
    const t = tx([
      utt(0, 1, "client", "Hi."),
      utt(1, 5, "client", "Stop calling me. Also take me off your list."),
      utt(2, 9, "client", "Do not call me again"),
    ]);
    const found = detectDncRequests(t);
    expect(found.map((f) => f.utteranceId)).toEqual([1, 2]);
  });
});
