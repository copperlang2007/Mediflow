/**
 * Client hook for the admin "Ready to Sell" readiness board.
 *
 * The readiness endpoint is hand-rolled (not in the generated OpenAPI client),
 * so this wraps `apiFetch` in react-query directly — same pattern as the live
 * queue hooks (lib/queue/api.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface CertifiedCarrier {
  carrierId: string;
  name: string | null;
}

export interface AgentReadiness {
  agentId: string;
  firstName: string;
  lastName: string;
  npn: string | null;
  status: string;
  active: boolean;
  ahipCurrent: boolean;
  licensedStates: string[];
  certifiedCarriers: CertifiedCarrier[];
  readyToSell: boolean;
  blockers: string[];
}

export interface ReadinessResponse {
  data: AgentReadiness[];
  readyCount: number;
  totalCount: number;
  certificationYear: number;
  asOf: string;
}

const READINESS_KEY = ["/api/agents/readiness"] as const;

/**
 * Org-wide agent readiness board. `certificationYear` is optional — the server
 * defaults to the current UTC year.
 */
export function useAgentReadiness(
  certificationYear?: number,
  enabled = true,
) {
  return useQuery({
    queryKey: [...READINESS_KEY, certificationYear ?? "current"],
    queryFn: () =>
      apiFetch<ReadinessResponse>(
        certificationYear
          ? `/api/agents/readiness?certificationYear=${certificationYear}`
          : "/api/agents/readiness",
      ),
    enabled,
    staleTime: 30_000,
  });
}
