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

const PRESENCE_KEY = ["/api/queue/presence"] as const;
const RECENT_ROUTING_KEY = ["/api/queue/routing/recent"] as const;

export function useQueuePresence(enabled = true) {
  return useQuery({
    queryKey: PRESENCE_KEY,
    queryFn: () => apiFetch<PresenceOverview>("/api/queue/presence"),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
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
