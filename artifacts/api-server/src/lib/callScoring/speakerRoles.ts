/**
 * Reviewer-confirmed speaker roles for recordings.
 *
 * A one-track recording is split by voice into "Speaker 1" / "Speaker 2". The
 * app never guesses which voice is the agent (see parse.ts). A person can say
 * so instead: this module turns that one choice into per-turn roles. Only the
 * numbered voice labels are touched; a file that already names its agent, and
 * turns whose voice was never told apart (plain "Speaker"), are left alone.
 */
import type { Role, SpeakerMode, Utterance } from "./types";

/** The labels speech.ts gives to voices it told apart. */
const VOICE_LABEL = /^Speaker \d+$/;

export interface SpeakerInfo {
  label: string;
  turns: number;
  role: Role;
}

export interface SpeakerSummary {
  speakers: SpeakerInfo[];
  /** True when a reviewer may choose which voice is the agent. */
  assignable: boolean;
}

export interface RoleSource {
  /** True when a reviewer already chose, so roles on the numbered voices came from that choice. */
  reassigning?: boolean;
}

/**
 * Roles that came with the file are trusted as-is, even on a numbered voice
 * (a JSON export can say {"speaker":"Speaker 1","role":"agent"}). The only
 * roles a reviewer may replace are the ones an earlier choice of theirs made.
 */
function fileSuppliedRoles(utterances: Utterance[], source: RoleSource): boolean {
  return utterances.some((u) => u.role !== "unknown" && !(source.reassigning && VOICE_LABEL.test(u.speaker)));
}

export function speakerSummary(utterances: Utterance[], source: RoleSource = {}): SpeakerSummary {
  if (fileSuppliedRoles(utterances, source)) return { speakers: [], assignable: false };
  const byLabel = new Map<string, SpeakerInfo>();
  for (const u of utterances) {
    if (!VOICE_LABEL.test(u.speaker)) continue;
    const seen = byLabel.get(u.speaker);
    if (seen) seen.turns += 1;
    else byLabel.set(u.speaker, { label: u.speaker, turns: 1, role: u.role });
  }
  const speakers = [...byLabel.values()];
  return { speakers, assignable: speakers.length > 0 };
}

export type ApplyResult =
  | { ok: true; utterances: Utterance[]; speakerMode: SpeakerMode }
  | { ok: false; message: string };

/**
 * `agentLabel` becomes the agent. The one other voice, if there is exactly one,
 * becomes the client; with more than one other voice they stay unknown, because
 * nothing says which of them is the client. Returns new objects.
 */
export function applyAgentSpeaker(utterances: Utterance[], agentLabel: string, source: RoleSource = {}): ApplyResult {
  const { speakers, assignable } = speakerSummary(utterances, source);
  if (!assignable) {
    return { ok: false, message: "This call has no separate voices to choose from." };
  }
  if (!speakers.some((s) => s.label === agentLabel)) {
    return { ok: false, message: "That voice is not in this call." };
  }
  const others = speakers.filter((s) => s.label !== agentLabel);
  const clientLabel = others.length === 1 ? others[0]!.label : null;

  const next = utterances.map((u): Utterance => {
    if (!VOICE_LABEL.test(u.speaker)) return { ...u };
    if (u.speaker === agentLabel) return { ...u, role: "agent" };
    if (u.speaker === clientLabel) return { ...u, role: "client" };
    return { ...u, role: "unknown" };
  });
  const hasAgent = next.some((u) => u.role === "agent");
  const hasClient = next.some((u) => u.role === "client");
  const speakerMode: SpeakerMode = hasAgent && hasClient ? "labelled" : hasAgent || hasClient ? "partial" : "unlabelled";
  return { ok: true, utterances: next, speakerMode };
}
