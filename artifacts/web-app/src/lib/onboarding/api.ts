/**
 * Onboarding + carrier-contracting React Query hooks.
 *
 * The transport layer (fetchers, query keys, mutation options) is now
 * generated from `lib/api-spec/openapi.yaml` (PR: openapi-regen). This file
 * thin-wraps the generated hooks to:
 *
 *   1. Preserve the public hook names that consumer pages + tests have
 *      historically imported (e.g. `useOnboarding`, `useStartOnboarding`).
 *   2. Layer on React Query cache invalidation + the "404 → null" swallow
 *      that the wizard depends on (codegen doesn't model that behaviour).
 *   3. Surface UI-only helpers (status-label maps, the `wizardStepForRun`
 *      state machine) that are pure-TS utilities, not API calls.
 *
 * Anything that IS a clean swap to a generated hook is done here. Anything
 * that is NOT auto-generated (label maps, state machine, query-key seed
 * after `start`) stays in this file.
 */
import {
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  useStartOnboarding as useStartOnboardingGenerated,
  useListOnboardings,
  useGetOnboarding,
  usePatchOnboardingProfile as usePatchOnboardingProfileGenerated,
  useSelectOnboardingCarriers,
  useCancelOnboarding as useCancelOnboardingGenerated,
  useRequestContracting as useRequestContractingGenerated,
  useSignOnboardingCarrier,
  useRecordCarrierContractingDecision,
  useRecordPoaDecision as useRecordPoaDecisionGenerated,
  useCreateEsignEnvelope,
  useGetEsignEnvelope,
  useSignEsignEnvelope,
  getListOnboardingsQueryKey,
  getGetOnboardingQueryKey,
  getGetEsignEnvelopeQueryKey,
  getOnboarding as getOnboardingFetcher,
  getEsignEnvelope as getEsignEnvelopeFetcher,
} from "@workspace/api-client-react";
import type {
  AgentOnboardingRun as GeneratedAgentOnboardingRun,
  AgentContractingProfile as GeneratedAgentContractingProfile,
  CarrierContractingRequest as GeneratedCarrierContractingRequest,
  OnboardingDetail as GeneratedOnboardingDetail,
  OnboardingListResponse as GeneratedOnboardingListResponse,
  OnboardingStatus as GeneratedOnboardingStatus,
  ContractingStatus as GeneratedContractingStatus,
  PoaStatus as GeneratedPoaStatus,
  EntityType as GeneratedEntityType,
  PatchOnboardingProfileBody,
  RecordContractingDecisionBody,
  PoaDecisionBody,
  PoaDecisionResponse,
  Envelope as GeneratedEnvelope,
  EnvelopeSigner as GeneratedEnvelopeSigner,
  EnvelopeConsentRecord as GeneratedEnvelopeConsentRecord,
  EnvelopeStatus as GeneratedEnvelopeStatus,
  CreateEsignEnvelopeBody,
  SignEnvelopeBody as GeneratedSignEnvelopeBody,
  SignEnvelopeResponse as GeneratedSignEnvelopeResponse,
} from "@workspace/api-client-react";

// ---------- Re-exported types ----------------------------------------------
// Surface generated types under the historically-stable names so consumer
// pages don't have to change their imports.

export type OnboardingStatus = GeneratedOnboardingStatus;
export type ContractingStatus = GeneratedContractingStatus;
export type PoaStatus = GeneratedPoaStatus;
export type EntityType = GeneratedEntityType;
export type AgentOnboardingRun = GeneratedAgentOnboardingRun;
export type AgentContractingProfile = GeneratedAgentContractingProfile;
export type CarrierContractingRequest = GeneratedCarrierContractingRequest;
// Tighter typing than the generated `OnboardingDetail` (which marks
// `profile` as optional-and-nullable). `useOnboarding` normalises the field
// to `null` so consumer code can rely on a non-undefined value.
export interface OnboardingDetail {
  run: GeneratedAgentOnboardingRun;
  profile: GeneratedAgentContractingProfile | null;
  carrierRequests: GeneratedCarrierContractingRequest[];
}
export type OnboardingListResponse = GeneratedOnboardingListResponse;
export type EnvelopeStatus = GeneratedEnvelopeStatus;
export type EnvelopeSigner = GeneratedEnvelopeSigner;
export type EnvelopeConsentRecord = GeneratedEnvelopeConsentRecord;
export type Envelope = GeneratedEnvelope;

// ---------- Local-only types ------------------------------------------------

export type ProfilePatch = PatchOnboardingProfileBody;
export type CarrierSelection = { carrierId: string; states: string[] };

export interface StartCarrierSignBody {
  pdfDocumentId: string;
  carrierContractingRequestId: string;
  signers: EnvelopeSigner[];
}

export interface StartCarrierSignResponse {
  envelopeId: string;
  status: EnvelopeStatus;
  signingUrl: string;
}

export interface SignEnvelopeBody extends GeneratedSignEnvelopeBody {
  consentToElectronicBusiness: true;
  intentToSign: true;
}

export type SignEnvelopeResponse = GeneratedSignEnvelopeResponse;

export interface RecordWritingNumberInput {
  requestId: string;
  writingNumber?: string;
  status?: "appointed" | "rejected" | "submitted" | "under_review";
  notes?: string;
}

// ---------- Hooks -----------------------------------------------------------

/**
 * GET /onboarding/:agentId — current run, profile, carrier requests for an
 * agent. Returns `null` when no active run exists (the generated hook would
 * throw on 404; the wizard depends on the swallow to branch on "no
 * onboarding in progress").
 */
export function useOnboarding(
  agentId: string | null | undefined,
  options?: Partial<UseQueryOptions<OnboardingDetail | null>>,
) {
  return useQuery<OnboardingDetail | null>({
    queryKey: getGetOnboardingQueryKey(agentId ?? ""),
    enabled: Boolean(agentId) && options?.enabled !== false,
    queryFn: async () => {
      try {
        const data = await getOnboardingFetcher(agentId ?? "");
        return {
          run: data.run,
          profile: data.profile ?? null,
          carrierRequests: data.carrierRequests,
        };
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
  return useListOnboardings(rest, {
    query: {
      enabled,
      queryKey: getListOnboardingsQueryKey(rest),
    },
  });
}

/** POST /onboarding/start — admin starts a run for an agent. Idempotent. */
export function useStartOnboarding() {
  const qc = useQueryClient();
  const mutation = useStartOnboardingGenerated({
    mutation: {
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
        // Seed the detail query so the caller can immediately navigate to it.
        qc.setQueryData(getGetOnboardingQueryKey(data.run.agentId), {
          run: data.run,
          profile: data.profile ?? null,
          carrierRequests: [],
        } satisfies OnboardingDetail);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: { agentId: string }) =>
      mutation.mutateAsync({ data: { agentId: vars.agentId } }),
    mutate: (vars: { agentId: string }) =>
      mutation.mutate({ data: { agentId: vars.agentId } }),
  };
}

/** PATCH /onboarding/:agentId/profile. */
export function usePatchOnboardingProfile(agentId: string) {
  const qc = useQueryClient();
  const mutation = usePatchOnboardingProfileGenerated({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (patch: ProfilePatch) =>
      mutation.mutateAsync({ agentId, data: patch }),
    mutate: (patch: ProfilePatch) => mutation.mutate({ agentId, data: patch }),
  };
}

/** POST /onboarding/:agentId/carriers/select. */
export function useSelectCarriers(agentId: string) {
  const qc = useQueryClient();
  const mutation = useSelectOnboardingCarriers({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: { selections: CarrierSelection[] }) =>
      mutation.mutateAsync({ agentId, data: { selections: vars.selections } }),
    mutate: (vars: { selections: CarrierSelection[] }) =>
      mutation.mutate({ agentId, data: { selections: vars.selections } }),
  };
}

/** POST /onboarding/:agentId/cancel. */
export function useCancelOnboarding(agentId: string) {
  const qc = useQueryClient();
  const mutation = useCancelOnboardingGenerated({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: () => mutation.mutateAsync({ agentId }),
    mutate: () => mutation.mutate({ agentId }),
  };
}

/** POST /onboarding/:agentId/request-contracting (admin). */
export function useRequestContracting(agentId: string) {
  const qc = useQueryClient();
  const mutation = useRequestContractingGenerated({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: () => mutation.mutateAsync({ agentId }),
    mutate: () => mutation.mutate({ agentId }),
  };
}

/**
 * POST /onboarding/:agentId/carriers/:carrierId/sign.
 *
 * Legacy synchronous stand-in. Kept for back-compat with any non-esign code
 * paths; the wizard now uses `useStartCarrierSign` + the `/sign/:envelopeId`
 * page instead.
 */
export function useSignCarrier(agentId: string) {
  const qc = useQueryClient();
  const mutation = useSignOnboardingCarrier({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: { carrierId: string }) =>
      mutation.mutateAsync({ agentId, requestId: vars.carrierId }),
    mutate: (vars: { carrierId: string }) =>
      mutation.mutate({ agentId, requestId: vars.carrierId }),
  };
}

// ---------- E-Sign (Beta) ---------------------------------------------------

/**
 * POST /esign/envelopes — create a signing envelope for a carrier contracting
 * request. Returns the envelopeId + signing URL the wizard navigates to.
 */
export function useStartCarrierSign(agentId: string, _requestId?: string) {
  const qc = useQueryClient();
  const mutation = useCreateEsignEnvelope({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: StartCarrierSignBody) =>
      mutation.mutateAsync({
        data: vars satisfies CreateEsignEnvelopeBody,
      }),
    mutate: (vars: StartCarrierSignBody) =>
      mutation.mutate({ data: vars satisfies CreateEsignEnvelopeBody }),
  };
}

/** GET /esign/envelopes/:envelopeId. */
export function useEnvelope(
  envelopeId: string | null | undefined,
  options?: Partial<UseQueryOptions<Envelope>>,
) {
  return useQuery<Envelope>({
    queryKey: getGetEsignEnvelopeQueryKey(envelopeId ?? ""),
    enabled: Boolean(envelopeId) && options?.enabled !== false,
    queryFn: async () => getEsignEnvelopeFetcher(envelopeId ?? ""),
    ...options,
  });
}

/** POST /esign/envelopes/:envelopeId/sign. */
export function useSignEnvelope(envelopeId: string) {
  const qc = useQueryClient();
  const mutation = useSignEsignEnvelope({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetEsignEnvelopeQueryKey(envelopeId) });
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: SignEnvelopeBody) =>
      mutation.mutateAsync({ envelopeId, data: vars }),
    mutate: (vars: SignEnvelopeBody) =>
      mutation.mutate({ envelopeId, data: vars }),
  };
}

/**
 * POST /onboarding/:agentId/poa-decision (Phase 1.5)
 *
 * Returns one of:
 *   - `{ poaStatus: "pending", envelopeId, signingUrl }` for `accepted: true`
 *   - `{ poaStatus: "opted_out", transitioned }` for `accepted: false`
 *
 * The wizard navigates to `signingUrl` on accept, or to the post-decline
 * confirmation view.
 */
export function usePoaDecision(agentId: string) {
  const qc = useQueryClient();
  const mutation = useRecordPoaDecisionGenerated({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: { accepted: boolean }) =>
      mutation.mutateAsync({
        agentId,
        data: { accepted: vars.accepted } satisfies PoaDecisionBody,
      }),
    mutate: (vars: { accepted: boolean }) =>
      mutation.mutate({
        agentId,
        data: { accepted: vars.accepted } satisfies PoaDecisionBody,
      }),
  };
}

export type { PoaDecisionResponse };

/**
 * PATCH /admin/contracting/:requestId (admin/compliance)
 *
 * Records the appointment-desk decision for a single carrier request:
 *   - writingNumber (final paperwork-trail identifier from the carrier)
 *   - optional explicit status override
 *   - optional notes (the column is overwritten, not appended; the audit
 *     log preserves the change trail).
 *
 * The hook invalidates the onboarding detail query on success so the
 * detail page refetches and shows the new writing number + status badge.
 * When the LAST outstanding carrier request flips to `appointed` the
 * backend rolls the onboarding run → `complete`.
 */
export function useRecordWritingNumber(agentId: string) {
  const qc = useQueryClient();
  const mutation = useRecordCarrierContractingDecision({
    mutation: {
      onSuccess: () => {
        // Refetch both the agent's detail (run/profile/requests) AND the
        // admin list — the list shows aggregate status badges that flip
        // when a run completes.
        void qc.invalidateQueries({ queryKey: getGetOnboardingQueryKey(agentId) });
        void qc.invalidateQueries({ queryKey: ["/api/onboarding"] });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (vars: RecordWritingNumberInput) => {
      const { requestId, ...body } = vars;
      return mutation.mutateAsync({
        requestId,
        data: body satisfies RecordContractingDecisionBody,
      });
    },
    mutate: (vars: RecordWritingNumberInput) => {
      const { requestId, ...body } = vars;
      return mutation.mutate({
        requestId,
        data: body satisfies RecordContractingDecisionBody,
      });
    },
  };
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
  awaiting_admin_submission: "Awaiting submission",
  invite_requested: "Invite requested",
};

const POA_LABELS: Record<PoaStatus, string> = {
  not_applicable: "Not yet decided",
  pending: "POA pending signature",
  signed: "POA signed",
  opted_out: "Opted out",
};

export function poaStatusLabel(s: PoaStatus | string | null | undefined): string {
  if (!s) return POA_LABELS.not_applicable;
  return POA_LABELS[s as PoaStatus] ?? s;
}

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
  | "poa"
  | "signing"
  | "done";

export function wizardStepForRun(
  run: AgentOnboardingRun,
  carrierRequests: CarrierContractingRequest[],
): WizardStep {
  if (run.status === "complete") return "done";
  if (run.status === "submitted") return "done";

  // Phase 1.5 POA branch — when the run has reached a decision, route
  // to the right view regardless of the underlying onboarding status.
  if (run.poaStatus === "opted_out") return "done";
  if (run.poaStatus === "signed") return "done";

  if (run.status === "signing") {
    // POA flow: agent should be on the POA step until they sign;
    // legacy per-carrier flow: agent should be on the per-carrier
    // signing step.
    if (run.poaStatus === "pending") return "poa";
    if (run.poaStatus === "not_applicable") return "signing";
    return "poa";
  }
  if (run.status === "carriers_selected") {
    // Phase 1.5: with carriers selected, the natural next step is the POA
    // decision. If carrier requests have any non-draft status (legacy
    // per-carrier flow), keep the old behaviour.
    if (
      carrierRequests.some(
        (r) =>
          r.status === "paperwork_generated" ||
          r.status === "signed" ||
          r.status === "submitted",
      )
    ) {
      return "signing";
    }
    return "poa";
  }
  if (run.status === "profile_in_progress") {
    if (carrierRequests.length > 0) return "review";
    return "carriers";
  }
  return "welcome";
}
