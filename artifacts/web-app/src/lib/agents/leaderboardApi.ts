/**
 * Client hook for the admin agent activity leaderboard / scorecard.
 *
 * The leaderboard endpoint is hand-rolled (not in the generated OpenAPI
 * client), so this wraps `apiFetch` in react-query directly — same pattern as
 * the readiness board hook (lib/readiness/api.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface AgentLeaderboardEntry {
  agentId: string;
  firstName: string;
  lastName: string;
  status: string;
  inboundsRouted: number;
  callbacksResolved: number;
  /** Open inbound-queue leads (the `leads` table) — routing workload. */
  openLeads: number;
  /** CRM contacts at the Lead stage assigned to the agent (shared definition). */
  leadContacts?: number;
  readyToSell: boolean;
  rank: number;
}

export interface AgentLeaderboardResponse {
  data: AgentLeaderboardEntry[];
  sinceHours: number;
  asOf: string;
}

const LEADERBOARD_KEY = ["/api/agents/leaderboard"] as const;

/**
 * Org-wide agent activity leaderboard over the last `sinceHours` (default
 * 168 = 7 days). The server clamps/validates `sinceHours` (1..2160).
 */
export function useAgentLeaderboard(sinceHours = 168, enabled = true) {
  return useQuery({
    queryKey: [...LEADERBOARD_KEY, sinceHours],
    queryFn: () =>
      apiFetch<AgentLeaderboardResponse>(
        `/api/agents/leaderboard?sinceHours=${sinceHours}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}
