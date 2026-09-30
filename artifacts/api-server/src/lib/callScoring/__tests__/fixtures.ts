/**
 * Test fixtures ONLY. Every person, plan and number below is invented.
 * Nothing here ships in the product or is used to seed any database.
 */
import type { ParsedTranscript, Role, SpeakerMode, Utterance } from "../types";

export function utt(id: number, startSec: number, role: Role, text: string, speaker?: string): Utterance {
  return {
    id,
    startSec,
    endSec: startSec + 4,
    speaker: speaker ?? (role === "agent" ? "Agent" : role === "client" ? "Customer" : "Speaker"),
    role,
    text,
  };
}

export function tx(
  utterances: Utterance[],
  opts: { durationSec?: number; timing?: "recorded" | "estimated"; mode?: SpeakerMode } = {},
): ParsedTranscript {
  const hasAgent = utterances.some((u) => u.role === "agent");
  const hasClient = utterances.some((u) => u.role === "client");
  return {
    utterances,
    speakerMode: opts.mode ?? (hasAgent && hasClient ? "labelled" : hasAgent || hasClient ? "partial" : "unlabelled"),
    timing: opts.timing ?? "recorded",
    durationSec: opts.durationSec ?? (utterances.at(-1)?.endSec ?? 0),
    format: "txt",
  };
}

const lines: Array<[number, "agent" | "client", string]> = [
  [0.4, "agent", "Thank you for calling Sunrise Benefits, my name is Dana Brooks and I'm a licensed insurance agent."],
  [6.0, "agent", "Before we get started, this call is being recorded for quality and compliance purposes."],
  [11.5, "client", "Okay, that's fine."],
  [13.0, "agent", "We do not offer every plan available in your area. Currently we represent 7 organizations which offer 42 products in your area."],
  [21.5, "agent", "Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program to get information on all of your options."],
  [30.5, "client", "Sure. I got a letter saying my plan is changing next year and I'm worried about my costs."],
  [36.0, "agent", "I understand, that's a really common concern this time of year. Before we look at plans, I need to confirm the scope of appointment."],
  [43.0, "agent", "Is it okay if we discuss Medicare Advantage and Part D prescription drug plans today?"],
  [47.5, "client", "Yes, that's fine."],
  [49.0, "agent", "Great. What coverage do you currently have?"],
  [52.0, "client", "I'm on a Medicare Advantage HMO through my old employer's recommendation, the premium went up to forty dollars."],
  [59.0, "agent", "Got it. Which doctors do you see regularly that you'd want to keep?"],
  [63.5, "client", "Doctor Patel is my primary care."],
  [70.0, "agent", "Thank you. And what prescriptions are you taking right now?"],
  [74.0, "client", "Just a generic. I use the Walgreens on Main Street."],
  [80.5, "agent", "Perfect. And is a monthly premium budget important to you, or would you rather have lower copays?"],
  [86.0, "client", "I'd like to keep it under fifty a month if I can."],
  [90.0, "agent", "Okay. Let me check Doctor Patel in the network."],
  [101.0, "agent", "Good news, the doctor is in network with the Evergreen Choice PPO."],
  [110.0, "agent", "Honestly this is the best plan out there, and if you stay where you are you'll lose your doctors next year."],
  [117.0, "client", "Oh, really? I didn't know that. What does the plan cost?"],
  [121.0, "agent", "The premium is zero dollars, the medical deductible is zero, primary care is a zero dollar copay, specialists are thirty five dollars, and the maximum out of pocket is five thousand nine hundred dollars in network."],
  [135.0, "agent", "Because it's a PPO you can see out of network doctors too, at a higher cost."],
  [140.0, "client", "That sounds good. Can you send me something to read before I decide?"],
  [144.0, "agent", "Absolutely. I'll email you the summary of benefits and the plan's drug list today, and I'll call you back Thursday at 2 PM to answer any questions."],
  [153.0, "client", "Thursday at two works. Thank you, Dana."],
  [156.0, "agent", "You're welcome, have a great day."],
];

/** An imperfect fictional Medicare call: a superlative and a scare line by the agent. */
export const sampleCall: ParsedTranscript = tx(
  lines.map(([start, role, text], i) => {
    const next = lines[i + 1]?.[0];
    const words = text.split(" ").length;
    const end = Math.min(start + words * 0.38, next !== undefined ? next - 0.2 : start + words * 0.38);
    return { id: i, startSec: start, endSec: Math.round(end * 10) / 10, speaker: role === "agent" ? "Agent" : "Customer", role, text };
  }),
  { durationSec: 159 },
);
