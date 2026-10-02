/**
 * Types, labels and small helpers for the Call scoring page. The shapes mirror
 * routes/callScoring.ts (api-server); nothing here invents data.
 */
import type { StatusTone } from "@/components/shared";
import { Button } from "@/components/ui/button";

/** Rows per page for the scored-calls list and the do-not-contact queue. */
export const PAGE_SIZE = 50;

/** Previous / Next controls tied to the API's `total`. Renders nothing when everything fits on one page. */
export function Pager({
  offset,
  limit = PAGE_SIZE,
  total,
  shown,
  onChange,
  label,
}: {
  offset: number;
  limit?: number;
  total: number;
  shown: number;
  onChange: (offset: number) => void;
  label: string;
}) {
  if (total <= limit && offset === 0) return null;
  const from = shown === 0 ? 0 : offset + 1;
  const to = offset + shown;
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-2" aria-label={`${label} pages`}>
      <p className="text-xs text-muted-foreground">
        Showing {from}-{to} of {total}
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => onChange(Math.max(0, offset - limit))} disabled={offset === 0}>
          Previous
        </Button>
        <Button size="sm" variant="outline" onClick={() => onChange(offset + limit)} disabled={offset + limit >= total}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export type Compliance = "pass" | "fail" | "review";
export type CriterionStatus = "pass" | "partial" | "fail" | "na" | "needs_review";
export type Speaker = "agent" | "client" | "unknown";

export interface CsConfig {
  rubrics: Array<{ id: string; name: string; version: string; description: string; passThreshold: number }>;
  defaultRubricId: string;
  ai: { status: "configured" | "needs_setup"; message: string };
  audio: { supported: boolean; message: string; maxBytes?: number; acceptedFormats?: string[]; layouts?: string[] };
  limits: { maxFileBytes: number; maxImportFiles: number; maxPasteChars: number; acceptedFormats: string[] };
  canCreate: boolean;
  canReview: boolean;
  disclaimer: string;
}

export interface CsSummary {
  truncated: boolean;
  totals: { total: number; pass: number; fail: number; review: number; avgScore: number | null; openDnc: number; needsReviewItems: number };
  byAgent: Array<{ agentId: string | null; name: string | null; total: number; pass: number; fail: number; review: number; avgScore: number | null }>;
  byRubric: Array<{ rubricId: string; rubricVersion: string; name: string; total: number; pass: number; fail: number; review: number; avgScore: number | null }>;
  disclaimer: string;
}

export interface CsListItem {
  id: string;
  createdAt: string;
  callDate: string | null;
  source: string;
  externalRef: string | null;
  speakerMode: "labelled" | "partial" | "unlabelled";
  timing: "recorded" | "estimated";
  contact: { id: string; name: string } | null;
  contactMatch: string;
  agent: { id: string; name: string } | null;
  rubric: { id: string; version: string };
  score: number;
  autoScore: number;
  compliance: Compliance;
  autoCompliance: Compliance;
  meetsStandard: boolean | null;
  criticalFailureCount: number;
  needsReviewCount: number;
  openDnc: number;
  reviewed: boolean;
  ai: { status: string; model: string | null };
}

export interface CsList {
  total: number;
  truncated: boolean;
  items: CsListItem[];
}

export interface CsEvidence {
  findingId: string;
  utteranceIndex: number;
  endUtteranceIndex: number | null;
  startOffset: number | null;
  endOffset: number | null;
  startSeconds: number | null;
  speaker: Speaker;
  quote: string | null;
  componentId: string | null;
}

export interface CsCriterion {
  criterionId: string;
  name: string;
  kind: string;
  severity: "critical" | "major" | "minor";
  description: string | null;
  citation: string | null;
  status: CriterionStatus;
  autoStatus: CriterionStatus;
  source: string;
  rationale: string;
  coaching: string | null;
  evidence: CsEvidence[];
  human: { verdict: string; note: string | null; reviewerName: string | null; reviewerRole: string | null; at: string } | null;
}

export interface CsDncFinding {
  findingId: string;
  fingerprint: string;
  utteranceIndex: number | null;
  startOffset: number | null;
  endOffset: number | null;
  startSeconds: number | null;
  speaker: Speaker;
  quote: string | null;
  status: "open" | "opt_out_added" | "dismissed";
  resolution: { action: string; note: string | null; reviewerName: string | null; at: string } | null;
}

export interface CsUtterance {
  id: number;
  startSec: number;
  endSec: number;
  speaker: string;
  role: Speaker;
  text: string;
}

export interface CsDetail {
  transcript: {
    id: string;
    source: string;
    format: string;
    externalRef: string | null;
    callDate: string | null;
    createdAt: string;
    retainUntil: string;
    speakerMode: "labelled" | "partial" | "unlabelled";
    timing: "recorded" | "estimated";
    filename: string | null;
    textAvailable: boolean;
    contact: { id: string; name: string } | null;
    contactMatch: string;
    agent: { id: string; name: string } | null;
  };
  utterances: CsUtterance[];
  disclaimer: string;
  score: null | {
    id: string;
    createdAt: string;
    rubric: { id: string; version: string; name: string; passThreshold: number | null };
    ai: { status: "used" | "needs_setup" | "failed" | "skipped"; model: string | null; error: string | null };
    auto: { score: number; compliance: Compliance; criticalFailures: string[]; needsReview: string[] };
    effective: { score: number; compliance: Compliance; criticalFailures: string[]; needsReview: string[]; openDnc: number; meetsStandard: boolean | null };
  };
  criteria: CsCriterion[];
  dnc: CsDncFinding[];
  reviews: Array<{ id: string; criterionId: string | null; verdict: string; note: string | null; reviewerName: string | null; at: string }>;
  previousScores: Array<{ id: string; createdAt: string; score: number; compliance: Compliance }>;
}

export interface CsDncItem {
  findingId: string;
  transcriptId: string;
  status: "open" | "opt_out_added" | "dismissed";
  quote: string | null;
  speaker: "client" | "unknown";
  utteranceIndex: number | null;
  startSeconds: number | null;
  createdAt: string;
  callDate: string | null;
  externalRef: string | null;
  speakerMode: string;
  contact: { id: string; name: string; phoneLast4: string | null; maskedEmail?: string | null } | null;
  contactMatch: string;
  candidates: Array<{ id: string; name: string; phoneLast4: string | null; maskedEmail?: string | null }>;
  moreCandidates?: boolean;
  channel?: "phone" | "email";
  channelAssumed?: boolean;
  emailOnFile?: boolean | null;
  numbers?: Array<{ source: "transcript" | "contact"; last4: string | null }>;
  agent: { id: string; name: string } | null;
  resolution: { action: string; note: string | null; reviewerName: string | null; at: string } | null;
}

export const QK = ["call-scoring"] as const;

export const COMPLIANCE_TONE: Record<Compliance, { label: string; tone: StatusTone }> = {
  pass: { label: "Passed", tone: "success" },
  fail: { label: "Failed", tone: "danger" },
  review: { label: "Needs review", tone: "warning" },
};

export const CRITERION_TONE: Record<CriterionStatus, { label: string; tone: StatusTone }> = {
  pass: { label: "Pass", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  fail: { label: "Fail", tone: "danger" },
  na: { label: "Not applicable", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warning" },
};

export const SEVERITY_LABEL = { critical: "Critical", major: "Major", minor: "Minor" } as const;

export const SPEAKER_LABEL: Record<Speaker, string> = { agent: "Agent", client: "Client", unknown: "Speaker not identified" };

export function fmtClock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function callLabel(i: { externalRef: string | null; callDate: string | null; createdAt: string }): string {
  return i.externalRef ?? `Call from ${fmtDate(i.callDate ?? i.createdAt)}`;
}

/** Plain-language server error, without ever echoing anything but the API's own message. */
export function apiMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: string } } | null)?.data;
  return data?.error ?? fallback;
}

export function apiData<T>(err: unknown): (T & { code?: string; error?: string }) | null {
  return ((err as { data?: unknown } | null)?.data as (T & { code?: string; error?: string }) | undefined) ?? null;
}

/** Honest caveats about how far to trust a score, from what the stored record says. */
export function scoreCaveats(d: CsDetail): string[] {
  const out: string[] = [];
  const t = d.transcript;
  if (t.speakerMode === "unlabelled") out.push("This file has no agent or client labels, so every turn is treated as an unknown speaker. Possible problems go to a person instead of failing the agent.");
  else if (t.speakerMode === "partial") out.push("Only one side of the call is labelled. The other side is treated as an unknown speaker.");
  if (t.timing === "estimated") out.push("This file has no timestamps, so times are estimated from word counts. Time-based checks that would fail are sent to a person.");
  const ai = d.score?.ai;
  if (ai?.status === "needs_setup") out.push("AI review is not set up, so judgment items are marked needs review.");
  else if (ai?.status === "failed") out.push(`${ai.error ?? "The AI reviewer failed."} Judgment items are marked needs review.`);
  else if (ai?.status === "skipped") out.push("Rules only: the AI reviewer was not run for this score.");
  if (t.contactMatch === "phone_ambiguous") out.push("More than one client uses this phone number, so no client was linked.");
  else if (t.contactMatch === "none" && !t.contact) out.push("This call is not linked to a client.");
  return out;
}
