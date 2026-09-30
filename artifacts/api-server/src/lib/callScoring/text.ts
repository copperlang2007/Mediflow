/**
 * Text normalization + searchable speech streams.
 *
 * Phrase rules are written against NORMALIZED text (lowercase, punctuation
 * removed, apostrophes dropped) so they survive the punctuation and casing
 * differences between transcript sources. Every normalized character keeps a
 * pointer back to the original character, so a match can be shown to a
 * reviewer as the exact words that were said, with a position.
 */
import type { Evidence, Role, Utterance } from "./types";

export interface NormalizedText {
  norm: string;
  /** map[i] = index in the original string of normalized character i. */
  map: number[];
}

const APOSTROPHES = new Set(["'", "’", "‘", "`"]);

/**
 * "We're NOT with Medicare.gov!" -> "were not with medicare gov"
 * `&` becomes " and "; apostrophes are dropped ("don't" -> "dont"); every other
 * symbol becomes a single space.
 */
export function normalizeMapped(raw: string): NormalizedText {
  const out: string[] = [];
  const map: number[] = [];
  const push = (ch: string, at: number) => {
    if (ch === " ") {
      if (out.length === 0 || out[out.length - 1] === " ") return;
    }
    out.push(ch);
    map.push(at);
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "&") {
      push(" ", i);
      for (const c of "and") push(c, i);
      push(" ", i);
      continue;
    }
    if (APOSTROPHES.has(ch)) continue;
    for (const lc of ch.toLowerCase()) push(/[a-z0-9]/.test(lc) ? lc : " ", i);
  }
  if (out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { norm: out.join(""), map };
}

export function normalize(text: string): string {
  return normalizeMapped(text).norm;
}

/** Compile rule patterns once. Patterns are regex sources written against normalized text. */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(`\\b(?:${p})\\b`, "g"));
}

/** Longest silence across which two consecutive turns may still form one phrase. */
export const MAX_JOIN_GAP_SEC = 5;

interface Segment {
  utteranceId: number;
  from: number;
  to: number;
  map: number[];
  raw: string;
}

/** Where a match sits in the original transcript. */
export interface Span {
  utteranceId: number;
  endUtteranceId: number;
  startOffset: number;
  endOffset: number;
  quote: string;
}

export interface StreamMatch extends Span {
  matched: string;
}

/**
 * A searchable stream of some speakers' speech. Consecutive utterances are
 * joined so a disclosure split across two segments still matches.
 */
export class SpeechStream {
  text = "";
  private segments: Segment[] = [];
  private byId = new Map<number, Utterance>();
  private last: Utterance | null = null;

  append(u: Utterance): void {
    const { norm, map } = normalizeMapped(u.text);
    this.byId.set(u.id, u);
    if (!norm) return;
    if (this.text) {
      // Words only join a phrase across ADJACENT turns close in time. If another
      // speaker's turn sits between them, or there is a long gap, a hard break
      // ("|" - which no pattern can match across) keeps "we do not" at 5s and
      // "offer every plan" at 90s from becoming one phrase credited at 5s.
      const prev = this.last;
      const adjacent = prev !== null && u.id === prev.id + 1 && u.startSec - prev.endSec <= MAX_JOIN_GAP_SEC;
      this.text += adjacent ? " " : " | ";
    }
    this.last = u;
    const from = this.text.length;
    this.text += norm;
    this.segments.push({ utteranceId: u.id, from, to: this.text.length, map, raw: u.text });
  }

  get isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** The original-text span for stream characters [from, to). */
  spanFor(from: number, to: number): Span | null {
    const hit = this.segments.filter((s) => s.from < to && s.to > from);
    const first = hit[0];
    const last = hit[hit.length - 1];
    if (!first || !last) return null;
    const startNorm = Math.max(from, first.from) - first.from;
    const endNorm = Math.min(to, last.to) - 1 - last.from;
    const startOffset = first.map[startNorm] ?? 0;
    const endOffset = (last.map[endNorm] ?? last.raw.length - 1) + 1;
    const quote =
      first === last
        ? first.raw.slice(startOffset, endOffset)
        : [first.raw.slice(startOffset), ...hit.slice(1, -1).map((s) => s.raw), last.raw.slice(0, endOffset)]
            .join(" ")
            .trim();
    return { utteranceId: first.utteranceId, endUtteranceId: last.utteranceId, startOffset, endOffset, quote };
  }

  utterance(id: number): Utterance | undefined {
    return this.byId.get(id);
  }

  /** All regex matches, each with its original-text span. Zero-length matches are skipped. */
  findAll(regexes: RegExp[]): StreamMatch[] {
    const out: StreamMatch[] = [];
    for (const re of regexes) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const span = this.spanFor(m.index, m.index + m[0].length);
        if (span) out.push({ ...span, matched: m[0] });
      }
    }
    return out.sort((a, b) => a.utteranceId - b.utteranceId || a.startOffset - b.startOffset);
  }
}

const SENTENCE_BREAKS = /[.!?;:—]/;
const CLAUSE_BREAKS = /[.!?;:,—]/;

/**
 * Up to `words` normalized words that precede a match inside its own
 * sentence (or clause), so negation is judged only on the words that could
 * actually govern the phrase. Never reaches into the previous utterance.
 */
export function wordsBefore(
  u: Utterance,
  startOffset: number,
  words: number,
  breaks: "sentence" | "clause" = "sentence",
): string {
  const re = breaks === "clause" ? CLAUSE_BREAKS : SENTENCE_BREAKS;
  const head = u.text.slice(0, startOffset);
  let cut = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    if (re.test(head[i]!)) {
      cut = i + 1;
      break;
    }
  }
  return normalize(head.slice(cut)).split(" ").filter(Boolean).slice(-words).join(" ");
}

const NEGATIONS = /\b(not|never|no|cant|cannot|wont|dont|doesnt|isnt|arent|wouldnt|couldnt|shouldnt)\b/;

/** True when a prohibited phrase is probably being negated ("I can't promise..."). */
export function looksNegated(before: string): boolean {
  return NEGATIONS.test(before);
}

export function roleMatches(role: Role, speaker: Role | "any" | undefined): boolean {
  const want = speaker ?? "agent";
  return want === "any" || role === want;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Evidence for a span, with the utterance's timing and role attached. */
export function toEvidence(span: Span, stream: SpeechStream, componentId?: string): Evidence | null {
  const first = stream.utterance(span.utteranceId);
  const last = stream.utterance(span.endUtteranceId);
  if (!first || !last) return null;
  return {
    utteranceId: span.utteranceId,
    endUtteranceId: span.endUtteranceId,
    startOffset: span.startOffset,
    endOffset: span.endOffset,
    startSec: first.startSec,
    endSec: last.endSec,
    role: first.role,
    quote: span.quote,
    ...(componentId ? { componentId } : {}),
  };
}
