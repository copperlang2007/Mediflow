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

// ---- Credential expiry (forward-looking early warning) ---------------------

export type CredentialType = "license" | "carrier_cert" | "ahip";
export type ExpiryTier = "expired" | "critical" | "soon" | "upcoming";

export interface ExpiringCredential {
  agentId: string;
  agentName: string;
  type: CredentialType;
  /** State code (license) / carrier name (cert) / cert year (ahip). */
  label: string;
  expiryDate: string;
  daysUntil: number;
  tier: ExpiryTier;
}

export interface CredentialExpiryResponse {
  data: ExpiringCredential[];
  withinDays: number;
  asOf: string;
  counts: { critical: number; soon: number; upcoming: number };
}

const EXPIRY_KEY = ["/api/agents/credential-expiry"] as const;

/**
 * Credentials expiring within `withinDays` for the org's active agents,
 * soonest-first. The server clamps/validates `withinDays` (1..365, default 60).
 */
export function useCredentialExpiry(withinDays = 60, enabled = true) {
  return useQuery({
    queryKey: [...EXPIRY_KEY, withinDays],
    queryFn: () =>
      apiFetch<CredentialExpiryResponse>(
        `/api/agents/credential-expiry?withinDays=${withinDays}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}
