/**
 * Client hook for the contact-page "Call summaries" (agent-assist) panel.
 *
 * Surfaces the in-platform parsed-transcript output (dialer Phase 5) for a
 * contact: a PHI-minimized summary, an advisory suggested disposition, risk
 * flags and action items. The endpoint is hand-rolled (not in the generated
 * OpenAPI client), so this wraps `apiFetch` in react-query directly — same
 * pattern as the other hand-rolled CRM/queue hooks.
 *
 * Read-only by design: the parsed result is advisory agent-assist, not a
 * disposition model. Nothing here mutates contact or ticket state.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Advisory disposition the agent confirms — never auto-applied. */
export interface SuggestedDisposition {
  code: string | null;
  category: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "COMPLIANCE" | "FOLLOW_UP" | "UNKNOWN";
  confidence: number | null;
}

export interface CallSummaryRiskFlag {
  kind: string;
  severity: "low" | "medium" | "high";
  detail: string;
}

export interface CallSummary {
  ticketId: string;
  dialerCallId: string | null;
  status: string;
  parsedAt: string | null;
  transcriptReadyAt: string | null;
  summary: string | null;
  suggestedDisposition: SuggestedDisposition | null;
  riskFlags: CallSummaryRiskFlag[];
  actionItems: string[];
}

export interface CallSummariesResponse {
  data: CallSummary[];
  total: number;
}

export function getContactCallSummariesQueryKey(contactId: string): unknown[] {
  return ["/api/contacts", contactId, "call-summaries"];
}

export function useContactCallSummaries(contactId: string) {
  return useQuery({
    queryKey: getContactCallSummariesQueryKey(contactId),
    queryFn: ({ signal }) =>
      apiFetch<CallSummariesResponse>(
        `/api/contacts/${contactId}/call-summaries`,
        { signal },
      ),
    enabled: Boolean(contactId),
    staleTime: 30_000,
  });
}
