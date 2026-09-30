/**
 * Transcript parsing (text only - there is no speech-to-text in phase 2a).
 *
 * Accepts plain text (pasted or .txt), WebVTT / SRT captions, and JSON:
 *  - a list of utterances, or an object with `utterances` / `segments` /
 *    `results.utterances`, each with `text` (or `transcript`) and optional
 *    `speaker`, `role`, `start`, `end` (seconds).
 *
 * Speaker labels are trusted ONLY when they say who is who ("Agent:",
 * "Customer:", "Dana Brooks (Agent)"). A neutral "Speaker 1" stays unknown and
 * the transcript is reported as partial/unlabelled so the UI and the scoring
 * rules can say so honestly. Roles are never guessed from what was said.
 *
 * Error messages are safe to show to a user: they never echo transcript text.
 */
import type { ParsedTranscript, Role, SpeakerMode, TimingMode, TranscriptFormat, Utterance } from "./types";

export class TranscriptParseError extends Error {}

export const PARSE_LIMITS = {
  maxChars: 1_000_000,
  maxUtterances: 20_000,
} as const;

interface RawUtterance {
  start?: number;
  end?: number;
  speaker: string;
  text: string;
  role?: Role;
}

const AGENT_LABEL =
  /^(?:agent|rep|representative|advisor|adviser|broker|sales ?rep|csr|licensed agent|insurance agent|producer|specialist|operator)$/;
const CLIENT_LABEL = /^(?:customer|caller|client|beneficiary|prospect|lead|member|patient|consumer|policyholder)$/;

/** agent / client only when the label says so explicitly; anything else is unknown. */
export function roleFromLabel(label: string): Role {
  const l = label.trim().toLowerCase();
  const paren = /\(([^)]+)\)\s*$/.exec(l)?.[1]?.trim();
  for (const cand of [paren, l.replace(/\s*\d+$/, "").trim()]) {
    if (!cand) continue;
    if (AGENT_LABEL.test(cand)) return "agent";
    if (CLIENT_LABEL.test(cand)) return "client";
  }
  return "unknown";
}

function detectFormat(content: string, filename: string | undefined): TranscriptFormat {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".vtt")) return "vtt";
  if (lower.endsWith(".srt")) return "srt";
  if (lower.endsWith(".txt")) return "txt";
  const head = content.trimStart();
  if (head.startsWith("WEBVTT")) return "vtt";
  if (head.startsWith("{") || head.startsWith("[{")) return "json";
  if (/^\d+\s*\n\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)) return "srt";
  return "paste";
}

export function parseTranscript(
  content: string,
  opts: { filename?: string; format?: TranscriptFormat } = {},
): ParsedTranscript {
  if (content.length > PARSE_LIMITS.maxChars) {
    throw new TranscriptParseError("The transcript is too large. Split it into shorter calls.");
  }
  const trimmed = content.replace(/^﻿/, "").trim();
  if (!trimmed) throw new TranscriptParseError("The transcript is empty.");
  if (trimmed.includes("\u0000")) {
    throw new TranscriptParseError("That does not look like a text transcript. Upload a TXT, VTT, SRT or JSON file.");
  }
  const format = opts.format ?? detectFormat(trimmed, opts.filename);
  let raw: RawUtterance[];
  if (format === "json") raw = parseJson(trimmed);
  else if (format === "vtt" || format === "srt") raw = parseCaptions(trimmed);
  else raw = parsePlainText(trimmed);
  if (!raw.length) throw new TranscriptParseError("No speech was found in the transcript.");
  if (raw.length > PARSE_LIMITS.maxUtterances) {
    throw new TranscriptParseError("The transcript has too many turns. Split it into shorter calls.");
  }
  return finalize(raw, format);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** ~2.6 words/second is typical conversational speech. */
function estimate(text: string): number {
  return Math.max(0.8, text.trim().split(/\s+/).length / 2.6);
}

function finalize(raw: RawUtterance[], format: TranscriptFormat): ParsedTranscript {
  const kept = raw.filter((r) => r.text.trim());
  const allTimed = kept.length > 0 && kept.every((r) => typeof r.start === "number" && Number.isFinite(r.start));
  const timing: TimingMode = allTimed ? "recorded" : "estimated";
  // Stable sort by start when the file gave every start time; otherwise keep file order.
  const ordered = allTimed ? [...kept].sort((a, b) => (a.start as number) - (b.start as number)) : kept;

  // A turn's own explicit role always wins. Otherwise the role comes from that
  // turn's own label. Nothing is carried from one turn to another, so a generic
  // label ("Speaker 1") can never turn a client's turn into agent speech.
  const roleOf = (r: RawUtterance): Role => (r.role && r.role !== "unknown" ? r.role : roleFromLabel(r.speaker));

  let clock = 0;
  const utterances: Utterance[] = ordered.map((r, id) => {
    const start = typeof r.start === "number" && Number.isFinite(r.start) ? r.start : clock;
    const end = typeof r.end === "number" && Number.isFinite(r.end) ? Math.max(r.end, start) : start + estimate(r.text);
    clock = end + 0.3;
    return {
      id,
      startSec: round(start),
      endSec: round(end),
      speaker: r.speaker,
      role: roleOf(r),
      text: r.text.trim(),
    };
  });
  // Estimated ends must not run into the next turn's start.
  for (let i = 0; i < utterances.length - 1; i++) {
    const cur = utterances[i]!;
    const next = utterances[i + 1]!;
    if (cur.endSec > next.startSec) cur.endSec = next.startSec;
  }

  const hasAgent = utterances.some((u) => u.role === "agent");
  const hasClient = utterances.some((u) => u.role === "client");
  const speakerMode: SpeakerMode = hasAgent && hasClient ? "labelled" : hasAgent || hasClient ? "partial" : "unlabelled";
  return {
    utterances,
    speakerMode,
    timing,
    durationSec: round(utterances[utterances.length - 1]?.endSec ?? 0),
    format,
  };
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function parseClock(ts: string): number {
  const parts = ts.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + (Number.isFinite(p) ? p : 0), 0);
}

const LABELLED_LINE =
  /^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?([A-Za-z][\w .'()-]{0,40}?)\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?)?\s*:\s+(.+)$/;

function parsePlainText(text: string): RawUtterance[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.some((l) => LABELLED_LINE.test(l))) {
    // No speaker labels anywhere: one unlabelled turn per line.
    return lines.map((l) => ({ speaker: "Speaker", text: l }));
  }
  const out: RawUtterance[] = [];
  for (const l of lines) {
    const m = LABELLED_LINE.exec(l);
    if (!m) {
      const prev = out[out.length - 1];
      if (prev) prev.text += ` ${l}`;
      else out.push({ speaker: "Speaker", text: l });
      continue;
    }
    const ts = m[1] ?? m[3];
    const speaker = m[2]!.trim();
    out.push({
      speaker,
      text: m[4]!.trim(),
      ...(ts ? { start: parseClock(ts) } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebVTT / SRT
// ---------------------------------------------------------------------------

function parseCaptions(text: string): RawUtterance[] {
  const out: RawUtterance[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx]!.split("-->");
    const start = parseClock(a!.trim().split(/\s+/)[0]!);
    const end = parseClock(b!.trim().split(/\s+/)[0]!);
    let body = lines.slice(timeIdx + 1).join(" ").trim();
    // A cue with no speaker tag stays unknown: it is NOT assumed to be the same
    // speaker as the previous cue.
    let speaker = "Speaker";
    const voice = /^<v(?:\.[^ >]*)? ([^>]+)>/.exec(body);
    if (voice) {
      speaker = voice[1]!.trim();
    } else {
      const named = /^([A-Za-z][\w .'()-]{0,40}):\s+(.*)$/.exec(body);
      if (named) {
        speaker = named[1]!.trim();
        body = named[2]!;
      }
    }
    body = body.replace(/<[^>]+>/g, "").trim();
    if (body) out.push({ start, end, speaker, text: body });
  }
  return mergeRuns(out);
}

function mergeRuns(items: RawUtterance[]): RawUtterance[] {
  const out: RawUtterance[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.speaker === it.speaker &&
      typeof prev.end === "number" &&
      typeof it.start === "number" &&
      it.start - prev.end < 1.0 &&
      prev.text.length < 400
    ) {
      prev.text += ` ${it.text}`;
      prev.end = it.end as number;
    } else out.push({ ...it });
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function parseJson(text: string): RawUtterance[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TranscriptParseError("The JSON file could not be read.");
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  const results = (obj["results"] ?? {}) as Record<string, unknown>;
  const list = [json, obj["utterances"], obj["segments"], results["utterances"]].find(Array.isArray) as unknown[] | undefined;
  if (!list) {
    throw new TranscriptParseError(
      "Unrecognized JSON. Expected a list of turns with text, or an object with utterances or segments.",
    );
  }
  const multichannel = Array.isArray(results["channels"]) && (results["channels"] as unknown[]).length > 1;
  const out: RawUtterance[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const body = [it["text"], it["transcript"], it["content"]].find((v) => typeof v === "string") as string | undefined;
    if (!body || !body.trim()) continue;
    const channel = typeof it["channel"] === "number" ? `ch${it["channel"]}` : undefined;
    const speakerRaw = it["speaker_label"] ?? it["speaker"] ?? (multichannel ? channel : undefined) ?? it["role"] ?? channel;
    const speaker = speakerRaw === undefined || speakerRaw === null ? "Speaker" : String(speakerRaw).slice(0, 60);
    const roleField = typeof it["role"] === "string" ? roleFromLabel(it["role"]) : undefined;
    const start = num(it["start"]) ?? num(it["start_time"]) ?? num(it["startTime"]);
    const end = num(it["end"]) ?? num(it["end_time"]) ?? num(it["endTime"]);
    out.push({
      speaker,
      text: body,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(roleField && roleField !== "unknown" ? { role: roleField } : {}),
    });
  }
  return out;
}
