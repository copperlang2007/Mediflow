/**
 * Onboarding + carrier-contracting REST helpers + React Query hooks.
 *
 * The Day-1/2/3 routes (`/onboarding/*`) are not yet in
 * `lib/api-spec/openapi.yaml`, so we don't have generated hooks for them
 * yet (Day 7+ task — see TODO below). Until then we go through the same
 * `apiFetch` wrapper that `admin-compliance.tsx` uses; auth + base path
 * are handled by `apiFetch` already.
 *
 * TODO(insureitall-day7): once the routes land in openapi.yaml, swap each
 * hook below to its generated equivalent + delete this file.
 */
import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---------- Shared types ----------------------------------------------------

export type OnboardingStatus =
  | "draft"
  | "profile_in_progress"
  | "carriers_selected"
  | "signing"
  | "submitted"
  | "complete"
  | "cancelled"
  | "rejected";

export type ContractingStatus =
  | "draft"
  | "paperwork_generated"
  | "signed"
  | "submitted"
  | "under_review"
  | "appointed"
  | "rejected"
  | "cancelled";

export type EntityType = "individual" | "llc" | "corp" | "partnership";

export interface AgentOnboardingRun {
  id: string;
  orgId: string;
  agentId: string;
  startedByUserId: string | null;
  status: OnboardingStatus;
  completedSteps?: Record<string, boolean> | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface AgentContractingProfile {
  id?: string;
  orgId: string;
  agentId: string;
  // SSN/EIN come back as either the formatted plaintext (privileged role
  // OR self-on-own-record) or a fixed masked sentinel.
  ssn: string | null;
  ein: string | null;
  dob: string | null;
  homeAddressLine1: string | null;
  homeAddressLine2: string | null;
  homeCity: string | null;
  homeState: string | null;
  homeZip: string | null;
  mailingSameAsHome: boolean | null;
  mailingAddressLine1: string | null;
  mailingAddressLine2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  phone: string | null;
  email: string | null;
  entityType: EntityType | null;
  businessName: string | null;
  eAndOCarrier: string | null;
  eAndOPolicyNumber: string | null;
  eAndOExpiresOn: string | null;
  backgroundCheckAuthorized?: boolean | null;
}

export interface CarrierContractingRequest {
  id: string;
  orgId: string;
  onboardingRunId: string;
  agentId: string;
  carrierId: string;
  states: string[];
  status: ContractingStatus;
  paperworkDocumentId: string | null;
  signatureCompletedAt: string | null;
  writingNumber?: string | null;
  lastStatusChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingDetail {
  run: AgentOnboardingRun;
  profile: AgentContractingProfile | null;
  carrierRequests: CarrierContractingRequest[];
}

export interface OnboardingListResponse {
  data: AgentOnboardingRun[];
  total: number;
  limit: number;
  offset: number;
}

// ---------- Query keys ------------------------------------------------------

export const onboardingKeys = {
  all: ["onboarding"] as const,
  list: (params: { status?: string; limit?: number; offset?: number }) =>
    ["onboarding", "list", params] as const,
  detail: (agentId: string) => ["onboarding", "detail", agentId] as const,
};

// ---------- Hooks -----------------------------------------------------------

/**
 * GET /onboarding/:agentId — current run, profile, carrier requests for an
 * agent. Returns `null` (via 404 swallow) when no active run exists, so
 * the UI can branch on "no onboarding in progress" without try/catch.
 */
export function useOnboarding(
  agentId: string | null | undefined,
  options?: Partial<UseQueryOptions<OnboardingDetail | null>>,
) {
  return useQuery<OnboardingDetail | null>({
    queryKey: onboardingKeys.detail(agentId ?? ""),
    enabled: Boolean(agentId) && options?.enabled !== false,
    queryFn: async () => {
      try {
        return await apiFetch<OnboardingDetail>(`/api/onboarding/${agentId}`);
      } catch (err) {
        const e = err as { status?: number } | undefined;
        if (e?.status === 404) return null;
        throw err;
      }
    },
    ...options,
  });
}

/** GET /onboarding (admin) — paginated list with `{data,total,limit,offset}`. */
export function useOnboardingList(params: {
  status?: string;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}) {
  const { enabled = true, ...rest } = params;
  return useQuery<OnboardingListResponse>({
    queryKey: onboardingKeys.list(rest),
    enabled,
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (rest.status) sp.set("status", rest.status);
      if (rest.limit != null) sp.set("limit", String(rest.limit));
      if (rest.offset != null) sp.set("offset", String(rest.offset));
      const q = sp.toString();
      return apiFetch<OnboardingListResponse>(
        `/api/onboarding${q ? `?${q}` : ""}`,
      );
    },
  });
}

/** POST /onboarding/start — admin starts a run for an agent. Idempotent. */
export function useStartOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { agentId: string }) =>
      apiFetch<{
        run: AgentOnboardingRun;
        profile: AgentContractingProfile | null;
        idempotent: boolean;
      }>(`/api/onboarding/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["onboarding"] });
      // Seed the detail query so the caller can immediately navigate to it.
      qc.setQueryData(onboardingKeys.detail(data.run.agentId), {
        run: data.run,
        profile: data.profile,
        carrierRequests: [],
      } satisfies OnboardingDetail);
    },
  });
}

/** PATCH /onboarding/:agentId/profile. */
export type ProfilePatch = Partial<{
  ssn: string | null;
  dob: string | null;
  homeAddressLine1: string | null;
  homeAddressLine2: string | null;
  homeCity: string | null;
  homeState: string | null;
  homeZip: string | null;
  mailingSameAsHome: boolean;
  mailingAddressLine1: string | null;
  mailingAddressLine2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  phone: string | null;
  email: string | null;
  entityType: EntityType | null;
  businessName: string | null;
  businessEin: string | null;
  eAndOCarrier: string | null;
  eAndOPolicyNumber: string | null;
  eAndOExpiresOn: string | null;
}>;

export function usePatchOnboardingProfile(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProfilePatch) =>
      apiFetch<{ profile: AgentContractingProfile }>(
        `/api/onboarding/${agentId}/profile`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.detail(agentId) });
    },
  });
}

/** POST /onboarding/:agentId/carriers/select. */
export type CarrierSelection = { carrierId: string; states: string[] };

export function useSelectCarriers(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { selections: CarrierSelection[] }) =>
      apiFetch<{ carrierRequests: CarrierContractingRequest[] }>(
        `/api/onboarding/${agentId}/carriers/select`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.detail(agentId) });
      void qc.invalidateQueries({ queryKey: ["onboarding", "list"] });
    },
  });
}

/** POST /onboarding/:agentId/cancel. */
export function useCancelOnboarding(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch<{ run: AgentOnboardingRun }>(
        `/api/onboarding/${agentId}/cancel`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.detail(agentId) });
      void qc.invalidateQueries({ queryKey: ["onboarding", "list"] });
    },
  });
}

/** POST /onboarding/:agentId/request-contracting (admin). */
export function useRequestContracting(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch<{
        run: AgentOnboardingRun;
        paperworkGenerated: number;
        signTasks: Array<{ requestId: string; taskId: string }>;
      }>(`/api/onboarding/${agentId}/request-contracting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.detail(agentId) });
      void qc.invalidateQueries({ queryKey: ["onboarding", "list"] });
    },
  });
}

/**
 * POST /onboarding/:agentId/carriers/:carrierId/sign.
 *
 * Day 3 stand-in: synchronous "I signed it" confirmation. Day 5 will
 * replace this with a Dropbox Sign envelope launch.
 *
 * NOTE: the backend route is keyed on `carrierId`, NOT `requestId` —
 * see `routes/onboarding.ts` line 1241. The carrier_contracting_requests
 * row is looked up by the (agent, carrier) pair.
 */
export function useSignCarrier(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { carrierId: string }) =>
      apiFetch<{
        request: CarrierContractingRequest;
        submitTaskId: string;
        idempotent: boolean;
      }>(
        `/api/onboarding/${agentId}/carriers/${vars.carrierId}/sign`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.detail(agentId) });
    },
  });
}

// ---------- Helpers ---------------------------------------------------------

const STATUS_LABELS: Record<OnboardingStatus, string> = {
  draft: "Draft",
  profile_in_progress: "Profile in progress",
  carriers_selected: "Awaiting admin review",
  signing: "Signing paperwork",
  submitted: "Submitted to carriers",
  complete: "Complete",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

export function onboardingStatusLabel(s: OnboardingStatus | string): string {
  return STATUS_LABELS[s as OnboardingStatus] ?? s;
}

const CONTRACTING_LABELS: Record<ContractingStatus, string> = {
  draft: "Draft",
  paperwork_generated: "Ready to sign",
  signed: "Signed",
  submitted: "Submitted",
  under_review: "Under review",
  appointed: "Appointed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function contractingStatusLabel(s: ContractingStatus | string): string {
  return CONTRACTING_LABELS[s as ContractingStatus] ?? s;
}

/**
 * Compute the wizard step the agent should land on given their current
 * onboarding run state. Centralised so the same state-machine drives
 * URL-derived navigation and the "next step" button on each page.
 */
export type WizardStep =
  | "welcome"
  | "profile"
  | "carriers"
  | "review"
  | "signing"
  | "done";

export function wizardStepForRun(
  run: AgentOnboardingRun,
  carrierRequests: CarrierContractingRequest[],
): WizardStep {
  if (run.status === "complete") return "done";
  if (run.status === "submitted") return "done";
  if (run.status === "signing") return "signing";
  if (run.status === "carriers_selected") {
    // If any paperwork has been generated already, jump to signing.
    if (carrierRequests.some((r) => r.status !== "draft" && r.status !== "cancelled")) {
      return "signing";
    }
    return "review";
  }
  if (run.status === "profile_in_progress") {
    if (carrierRequests.length > 0) return "review";
    return "carriers";
  }
  return "welcome";
}
