/**
 * Call scoring domain types (phase 2a: text transcripts only).
 *
 * The scoring engine is a port of the useful parts of the myCALL product:
 * deterministic phrase rules first, an optional AI reviewer second, and a
 * fail-closed merge. Everything here assists a human reviewer; nothing in this
 * module certifies compliance or gives legal advice.
 */

/** Who is speaking. Only explicit labels ever set agent/client; everything else is unknown. */
export type Role = "agent" | "client" | "unknown";

/** One stretch of speech. `id` is the utterance's index in the transcript. */
export interface Utterance {
  id: number;
  /** Seconds from the start of the call (estimated from word count when `timing` is "estimated"). */
  startSec: number;
  endSec: number;
  /** The label exactly as it appeared in the source ("Dana Brooks", "Speaker 1"). May be a person's name. */
  speaker: string;
  role: Role;
  text: string;
}

/** labelled = agent and client both identified; partial = only one; unlabelled = neither. */
export type SpeakerMode = "labelled" | "partial" | "unlabelled";

/** recorded = timestamps came from the file; estimated = derived from word counts. */
export type TimingMode = "recorded" | "estimated";

export type TranscriptFormat = "paste" | "txt" | "vtt" | "srt" | "json";

export interface ParsedTranscript {
  utterances: Utterance[];
  speakerMode: SpeakerMode;
  timing: TimingMode;
  durationSec: number;
  format: TranscriptFormat;
}

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

/**
 * critical = a failure fails the whole call (compliance gate), regardless of score.
 * major / minor only affect the quality score through points.
 */
export type Severity = "critical" | "major" | "minor";

/**
 * required   - something the speaker MUST say (disclosures, discovery questions).
 * prohibited - something the speaker must NOT say.
 * judgment   - qualitative skill only an AI (or human) reviewer can assess.
 */
export type CriterionKind = "required" | "prohibited" | "judgment";

/**
 * rules  - deterministic phrase rules only.
 * llm    - AI reviewer only.
 * hybrid - rules run first; the AI reviewer may confirm a paraphrase or add context.
 */
export type Evaluator = "rules" | "llm" | "hybrid";

export interface PhraseComponent {
  id: string;
  label: string;
  /** Regex sources matched against normalized text (lowercase, no punctuation). */
  patterns: string[];
}

export interface Criterion {
  id: string;
  sectionId: string;
  name: string;
  description: string;
  /** The regulation or policy the criterion enforces, shown to reviewers. */
  citation?: string;
  points: number;
  severity: Severity;
  kind: CriterionKind;
  evaluator: Evaluator;
  /** Whose speech is checked. Default "agent". */
  speaker?: Role | "any";
  /** Required/prohibited: phrase patterns (any match counts). */
  patterns?: string[];
  /** Required: multi-part statements; every component must be found (or minComponents). */
  components?: PhraseComponent[];
  /** Required: how many components earn full credit (default all). Partial credit below. */
  minComponents?: number;
  /** Required: must be completed within N seconds of call start. */
  withinSeconds?: number;
  /**
   * Required: the evidence must come BEFORE the first statement (by the same
   * speaker) matching any of these patterns - e.g. a scope-of-appointment
   * confirmation must precede the first plan-specific discussion. A mention
   * that only comes after that point never passes; a person decides.
   */
  mustPrecede?: string[];
  /** Extra instructions for the AI reviewer. */
  guidance?: string;
  /** Short coaching line shown when the item is missing or violated. */
  hint?: string;
}

export interface RubricSection {
  id: string;
  name: string;
  description?: string;
}

export interface Rubric {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Minimum quality score for a "meets standard" outcome (0-100). */
  passThreshold: number;
  sections: RubricSection[];
  criteria: Criterion[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Where a quote sits. Offsets are character positions in the ORIGINAL
 * utterance text (not the normalized text), so the UI can highlight the words.
 */
export interface Evidence {
  utteranceId: number;
  /** Utterance where the quote ends (equals utteranceId unless it spans a segment boundary). */
  endUtteranceId: number;
  startOffset: number;
  /** Offset inside utterance `endUtteranceId`. */
  endOffset: number;
  startSec: number;
  endSec: number;
  role: Role;
  quote: string;
  /** Which component of a multi-part requirement this proves, if any. */
  componentId?: string;
}

export type CriterionStatus = "pass" | "partial" | "fail" | "na" | "needs_review";

export type ResultSource = "rules" | "llm" | "rules+llm";

export interface CriterionResult {
  criterionId: string;
  status: CriterionStatus;
  /** 0..1 share of points earned. Ignored for na / needs_review. */
  fraction: number;
  earned: number;
  maxPoints: number;
  evidence: Evidence[];
  rationale: string;
  source: ResultSource;
  coaching?: string;
  /** Required criteria with components: which were found. */
  componentsFound?: string[];
}

export type ComplianceStatus = "pass" | "fail" | "review";

export interface ScoreTotals {
  /** 0-100 weighted quality score over criteria that could be assessed. */
  score: number;
  compliance: ComplianceStatus;
  criticalFailures: string[];
  needsReview: string[];
}

export type AiStatus = "used" | "needs_setup" | "failed" | "skipped";

/** Human decision on one criterion. "needs_review" is never a final answer. */
export type ReviewedStatus = "pass" | "partial" | "fail" | "na";
