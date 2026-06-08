/**
 * Client hook for the agent self-serve commission portal.
 *
 * The `/commissions/me` endpoint is hand-rolled (not in the generated
 * OpenAPI client), so this wraps `apiFetch` in react-query directly — same
 * pattern as the leaderboard hook (lib/agents/leaderboardApi.ts).
 *
 * It returns the caller's OWN commission statements (rows from
 * agent_commission_payouts) plus a paid-vs-pending summary. The server
 * resolves the agent from the Clerk session and 404s when no agent row is
 * linked to the user.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface MyCommissionStatement {
  id: string;
  orgId: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  earned: number | string;
  paid: number | string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MyCommissionsSummary {
  totalPaid: number;
  totalPending: number;
  paidCount: number;
  pendingCount: number;
  statementCount: number;
}

export interface MyCommissionsResponse {
  data: MyCommissionStatement[];
  summary: MyCommissionsSummary;
  asOf: string;
}

const MY_COMMISSIONS_KEY = ["/api/commissions/me"] as const;

/**
 * The authenticated agent's own commission statements + summary. `enabled`
 * lets callers defer the request until the role check has resolved.
 */
export function useMyCommissions(enabled = true) {
  return useQuery({
    queryKey: MY_COMMISSIONS_KEY,
    queryFn: () => apiFetch<MyCommissionsResponse>("/api/commissions/me"),
    enabled,
    staleTime: 30_000,
  });
}
