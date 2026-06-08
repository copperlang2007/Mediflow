/**
 * Client hooks for the admin "Live Queue" view.
 *
 * The inbound-queue endpoints are hand-rolled (not in the generated OpenAPI
 * client), so these wrap `apiFetch` in react-query directly. Both poll on a
 * short interval so the view stays live without a manual refresh.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface PresenceAgent {
  agentId: string;
  firstName: string;
  lastName: string;
  status: string;
  lastSeenAt: string;
  expiresAt: string | null;
  availableNow: boolean;
}

export interface PresenceOverview {
  agents: PresenceAgent[];
  availableCount: number;
  asOf: string;
}

export interface RoutingDecision {
  id: string;
  createdAt: string;
  status: "routed" | "no_agent_available";
  stateCode: string;
  carrierId: string;
  carrierName: string | null;
  agentId: string | null;
  agentFirstName: string | null;
  agentLastName: string | null;
  candidatePool: number;
  source: string | null;
  presenceFiltered: boolean;
}

export interface RoutingCarrierBreakdown {
  carrierId: string;
  carrierName: string | null;
  routed: number;
  noAgent: number;
}

export interface RoutingStateBreakdown {
  stateCode: string;
  routed: number;
  noAgent: number;
}

export interface RoutingStats {
  total: number;
  routed: number;
  noAgent: number;
  routedRate: number;
  avgCandidatePool: number;
  byCarrier: RoutingCarrierBreakdown[];
  byState: RoutingStateBreakdown[];
}

export interface CoverageGap {
  carrierId: string;
  carrierName: string | null;
  stateCode: string;
  noAgentCount: number;
  lastOccurrence: string;
  availableNow: number;
}

export interface RoutingStatsResponse {
  stats: RoutingStats;
  coverageGaps: CoverageGap[];
  sinceHours: number;
  asOf: string;
}

const PRESENCE_KEY = ["/api/queue/presence"] as const;
const RECENT_ROUTING_KEY = ["/api/queue/routing/recent"] as const;
const ROUTING_STATS_KEY = ["/api/queue/routing/stats"] as const;

export function useQueuePresence(enabled = true) {
  return useQuery({
    queryKey: PRESENCE_KEY,
    queryFn: () => apiFetch<PresenceOverview>("/api/queue/presence"),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

/**
 * Windowed routing analytics + coverage-gap list. Polls every ~30s (slower
 * than presence — these are aggregate trends, not a live feed).
 */
export function useRoutingStats(sinceHours = 24, enabled = true) {
  return useQuery({
    queryKey: [...ROUTING_STATS_KEY, sinceHours],
    queryFn: () =>
      apiFetch<RoutingStatsResponse>(
        `/api/queue/routing/stats?sinceHours=${sinceHours}`,
      ),
    enabled,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

export function useRecentRouting(limit = 50, enabled = true) {
  return useQuery({
    queryKey: [...RECENT_ROUTING_KEY, limit],
    queryFn: () =>
      apiFetch<{ data: RoutingDecision[]; total: number }>(
        `/api/queue/routing/recent?limit=${limit}`,
      ),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
