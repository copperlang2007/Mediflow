/**
 * Deterministic phrase-rule engine.
 *
 * Runs over a complete transcript with no network and no AI, so it is free,
 * instant and repeatable: the same transcript always yields the same findings.
 *
 *  - prohibited phrases are negation-aware ("I can't promise..." is flagged as
 *    "negated only" for a person to confirm, not as a violation);
 *  - required disclosures can carry a time window ("within the first 60
 *    seconds") and may be made of several parts that must all be found;
 *  - every finding carries the exact words and where they sit.
 */
import type { Criterion, Evidence, Role, Rubric, Utterance } from "./types";
import type { ParsedTranscript } from "./types";
import {
  SpeechStream,
  compilePatterns,
  looksNegated,
  toEvidence,
  wordsBefore,
  type StreamMatch,
} from "./text";

export interface RuleFinding {
  criterionId: string;
  /** Required: evidence the item was said. Prohibited: the hits. */
  evidence: Evidence[];
  componentsFound: string[];
  componentsTotal: number;
  /** Required: fully satisfied inside its time window. */
  satisfied: boolean;
  /** Required: found, but only after the time window closed. */
  late: boolean;
  /**
   * Required with `mustPrecede`: the words were found, but only AFTER the first
   * plan-specific statement. Never a pass; a person decides.
   */
  outOfOrder: boolean;
  /** Required with `mustPrecede`: where the first plan-specific statement sits (evidence must come before it). */
  precedeLimit: { utteranceId: number; startOffset: number } | null;
  /** Prohibited: at least one hit that does not look negated. */
  violated: boolean;
  /** Prohibited: hits exist but every one looks negated ("I can't promise..."). */
  negatedOnly: boolean;
  /**
   * True when the speaker for this criterion could not be confirmed from
   * labels (no agent label in the file), so the words were searched across
   * unlabelled speech. A hit then cannot be pinned on the agent.
   */
  speakerUnverified: boolean;
  /** True when a time window applied but the transcript's timing is estimated. */
  timingEstimated: boolean;
}

interface Streams {
  agent: SpeechStream;
  client: SpeechStream;
  unknown: SpeechStream;
  any: SpeechStream;
}

export function buildStreams(utterances: Utterance[]): Streams {
  const s: Streams = {
    agent: new SpeechStream(),
    client: new SpeechStream(),
    unknown: new SpeechStream(),
    any: new SpeechStream(),
  };
  for (const u of utterances) {
    s.any.append(u);
    s[u.role].append(u);
  }
  return s;
}

/**
 * Which stream a criterion should search. When the transcript has no label
 * for the wanted side, fall back to the unlabelled speech and say so - never
 * pretend the speaker was verified.
 */
export function streamFor(
  streams: Streams,
  wanted: Role | "any",
): { stream: SpeechStream; unverified: boolean } {
  if (wanted === "any") return { stream: streams.any, unverified: false };
  if (!streams[wanted].isEmpty) return { stream: streams[wanted], unverified: false };
  return { stream: streams.unknown, unverified: true };
}

const NEGATION_WORDS_BEFORE = 6;

function scanProhibited(
  c: Criterion,
  stream: SpeechStream,
  unverified: boolean,
  timingEstimated: boolean,
): RuleFinding {
  const finding = emptyFinding(c, unverified, timingEstimated);
  const regexes = compilePatterns(c.patterns ?? []);
  // One piece of evidence per utterance, even when several patterns hit it.
  const groups = new Map<string, { match: StreamMatch; negated: boolean }>();
  for (const m of stream.findAll(regexes)) {
    const u = stream.utterance(m.utteranceId);
    if (!u) continue;
    const negated = looksNegated(wordsBefore(u, m.startOffset, NEGATION_WORDS_BEFORE));
    const key = `${m.utteranceId}:${m.endUtteranceId}`;
    const prior = groups.get(key);
    if (!prior) groups.set(key, { match: m, negated });
    else if (prior.negated && !negated) groups.set(key, { match: m, negated: false });
  }
  for (const { match, negated } of groups.values()) {
    const ev = toEvidence(match, stream);
    if (!ev) continue;
    finding.evidence.push(ev);
    if (!negated) finding.violated = true;
  }
  finding.negatedOnly = finding.evidence.length > 0 && !finding.violated;
  return finding;
}

function scanRequired(
  c: Criterion,
  stream: SpeechStream,
  unverified: boolean,
  timingEstimated: boolean,
): RuleFinding {
  const f = emptyFinding(c, unverified, timingEstimated);
  const window = c.withinSeconds;
  const inWindow = (ev: Evidence) => window === undefined || ev.startSec <= window;

  if (c.components?.length) {
    const lateComponents = new Set<string>();
    // Representative late evidence per component, so a reviewer can jump to it.
    const lateEvidence: Evidence[] = [];
    for (const comp of c.components) {
      for (const m of stream.findAll(compilePatterns(comp.patterns))) {
        const ev = toEvidence(m, stream, comp.id);
        if (!ev) continue;
        if (!inWindow(ev)) {
          if (!lateComponents.has(comp.id)) lateEvidence.push(ev);
          lateComponents.add(comp.id);
          continue;
        }
        f.componentsFound.push(comp.id);
        f.evidence.push(ev);
        break;
      }
    }
    const need = c.minComponents ?? c.components.length;
    if (f.componentsFound.length >= need) f.satisfied = true;
    else {
      f.late = new Set([...f.componentsFound, ...lateComponents]).size >= need;
      // Not satisfied in time: keep the late quotes next to the timely ones.
      f.evidence.push(...lateEvidence.filter((l) => !f.componentsFound.includes(l.componentId ?? "")));
    }
    return f;
  }

  const limit = c.mustPrecede?.length ? firstPosition(stream, c.mustPrecede) : null;
  f.precedeLimit = limit;
  for (const m of stream.findAll(compilePatterns(c.patterns ?? []))) {
    const ev = toEvidence(m, stream);
    if (!ev) continue;
    if (!inWindow(ev)) {
      f.late = true;
      if (!f.evidence.length) f.evidence.push(ev);
      continue;
    }
    if (limit && !isBefore(ev, limit)) {
      // Said, but only after plan-specific discussion began. Matches are in
      // order, so every later one is also too late.
      f.outOfOrder = true;
      f.evidence = [ev];
      break;
    }
    f.evidence = [ev];
    f.satisfied = true;
    f.late = false;
    break;
  }
  return f;
}

/** Where the earliest match of any of these patterns sits in the stream. */
function firstPosition(stream: SpeechStream, patterns: string[]): { utteranceId: number; startOffset: number } | null {
  let best: { utteranceId: number; startOffset: number } | null = null;
  for (const m of stream.findAll(compilePatterns(patterns))) {
    if (!best || m.utteranceId < best.utteranceId || (m.utteranceId === best.utteranceId && m.startOffset < best.startOffset)) {
      best = { utteranceId: m.utteranceId, startOffset: m.startOffset };
    }
  }
  return best;
}

/** True when the evidence starts strictly before the position. */
export function isBefore(ev: { utteranceId: number; startOffset: number }, at: { utteranceId: number; startOffset: number }): boolean {
  return ev.utteranceId < at.utteranceId || (ev.utteranceId === at.utteranceId && ev.startOffset < at.startOffset);
}

function emptyFinding(c: Criterion, unverified: boolean, timingEstimated: boolean): RuleFinding {
  return {
    criterionId: c.id,
    evidence: [],
    componentsFound: [],
    componentsTotal: c.components?.length ?? 0,
    satisfied: false,
    late: false,
    outOfOrder: false,
    precedeLimit: null,
    violated: false,
    negatedOnly: false,
    speakerUnverified: unverified,
    timingEstimated: timingEstimated && c.withinSeconds !== undefined,
  };
}

/** Criteria the rule engine can evaluate (everything except pure AI judgment). */
export function ruleCriteria(rubric: Rubric): Criterion[] {
  return rubric.criteria.filter((c) => c.evaluator !== "llm" && c.kind !== "judgment");
}

/** Run every rules-capable criterion over a complete transcript. */
export function runRules(rubric: Rubric, transcript: ParsedTranscript): RuleFinding[] {
  const streams = buildStreams(transcript.utterances);
  const estimated = transcript.timing === "estimated";
  return ruleCriteria(rubric).map((c) => {
    const want = c.speaker ?? "agent";
    const scan = (s: SpeechStream, unverified: boolean) =>
      c.kind === "prohibited" ? scanProhibited(c, s, unverified, estimated) : scanRequired(c, s, unverified, estimated);
    const { stream, unverified } = streamFor(streams, want);
    const primary = scan(stream, unverified);
    // In a PARTLY labelled transcript the unattributed turns could be the
    // agent's (or the client's), so they are searched too. Anything found only
    // there is speaker-unverified and goes to a person; it never passes or fails
    // on its own.
    if (unverified || want === "any" || want === "unknown" || streams.unknown.isEmpty) return primary;
    const extra = scan(streams.unknown, true);
    return c.kind === "prohibited" ? mergeProhibited(primary, extra) : mergeRequired(primary, extra);
  });
}

function mergeProhibited(primary: RuleFinding, extra: RuleFinding): RuleFinding {
  // A hit by an identified speaker stands as it is.
  if (primary.violated || !extra.evidence.length) return primary;
  const evidence = [...primary.evidence, ...extra.evidence];
  const violated = extra.violated;
  return { ...primary, evidence, violated, negatedOnly: evidence.length > 0 && !violated, speakerUnverified: true };
}

function mergeRequired(primary: RuleFinding, extra: RuleFinding): RuleFinding {
  if (primary.satisfied || !extra.satisfied) return primary;
  // Said only in unattributed speech: possibly the client. Not credit until a person confirms.
  return { ...extra, speakerUnverified: true };
}
