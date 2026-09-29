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
    for (const comp of c.components) {
      for (const m of stream.findAll(compilePatterns(comp.patterns))) {
        const ev = toEvidence(m, stream, comp.id);
        if (!ev) continue;
        if (!inWindow(ev)) {
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
    else f.late = new Set([...f.componentsFound, ...lateComponents]).size >= need;
    return f;
  }

  for (const m of stream.findAll(compilePatterns(c.patterns ?? []))) {
    const ev = toEvidence(m, stream);
    if (!ev) continue;
    if (!inWindow(ev)) {
      f.late = true;
      if (!f.evidence.length) f.evidence.push(ev);
      continue;
    }
    f.evidence = [ev];
    f.satisfied = true;
    f.late = false;
    break;
  }
  return f;
}

function emptyFinding(c: Criterion, unverified: boolean, timingEstimated: boolean): RuleFinding {
  return {
    criterionId: c.id,
    evidence: [],
    componentsFound: [],
    componentsTotal: c.components?.length ?? 0,
    satisfied: false,
    late: false,
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
    const { stream, unverified } = streamFor(streams, c.speaker ?? "agent");
    return c.kind === "prohibited"
      ? scanProhibited(c, stream, unverified, estimated)
      : scanRequired(c, stream, unverified, estimated);
  });
}
