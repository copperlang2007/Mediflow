// @vitest-environment jsdom
/**
 * Render tests for the Phase 1.5 PoaDecisionStep. We seed `useGetCarriers`
 * + the POA decision mutation via the QueryClient and mock the wouter
 * navigation hook so the tests don't depend on a router instance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetCarriersQueryKey } from "@workspace/api-client-react";
import { PoaDecisionStep } from "@/pages/onboarding/steps/PoaDecisionStep";
import type { CarrierContractingRequest } from "@/lib/onboarding/api";

let mockSetLocation = vi.fn();
vi.mock("wouter", async () => ({
  useLocation: () => ["", mockSetLocation],
}));

// Mock the api hook so we can drive the mutation deterministically without
// hitting the network. We replace just `usePoaDecision`.
const mockMutateAsync = vi.fn();
vi.mock("@/lib/onboarding/api", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/onboarding/api")
  >();
  return {
    ...actual,
    usePoaDecision: () => ({
      mutateAsync: mockMutateAsync,
      isPending: false,
    }),
  };
});

function makeClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  qc.setQueryData(getGetCarriersQueryKey(), [
    { id: "c-aetna", name: "Aetna" },
    { id: "c-humana", name: "Humana" },
  ]);
  return qc;
}

function mkReq(
  overrides: Partial<CarrierContractingRequest>,
): CarrierContractingRequest {
  return {
    id: "r-1",
    orgId: "org-1",
    onboardingRunId: "run-1",
    agentId: "agent-1",
    carrierId: "c-aetna",
    states: ["FL"],
    status: "draft",
    paperworkDocumentId: null,
    signatureCompletedAt: null,
    lastStatusChangeAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("PoaDecisionStep", () => {
  beforeEach(() => {
    mockSetLocation = vi.fn();
    mockMutateAsync.mockReset();
  });

  it("renders both options with carrier list", () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <PoaDecisionStep
          agentId="agent-1"
          carrierRequests={[
            mkReq({ id: "r-1", carrierId: "c-aetna" }),
            mkReq({ id: "r-2", carrierId: "c-humana" }),
          ]}
          onContinue={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("poa-decision-step")).toBeInTheDocument();
    expect(screen.getByText("Aetna")).toBeInTheDocument();
    expect(screen.getByText("Humana")).toBeInTheDocument();
    expect(screen.getByTestId("poa-accept-btn")).toBeInTheDocument();
    expect(screen.getByTestId("poa-decline-btn")).toBeInTheDocument();
  });

  it("excludes cancelled carriers from the count", () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <PoaDecisionStep
          agentId="agent-1"
          carrierRequests={[
            mkReq({ id: "r-1", carrierId: "c-aetna" }),
            mkReq({ id: "r-2", carrierId: "c-humana", status: "cancelled" }),
          ]}
          onContinue={() => {}}
        />
      </QueryClientProvider>,
    );
    // Active count is 1.
    expect(screen.getByText(/You selected/)).toBeInTheDocument();
    expect(screen.queryByText("Humana")).not.toBeInTheDocument();
  });

  it("clicking accept navigates to the signing URL on success", async () => {
    mockMutateAsync.mockResolvedValueOnce({
      poaStatus: "pending",
      envelopeId: "env-abc",
      signingUrl: "/sign/env-abc",
      idempotent: false,
    });

    render(
      <QueryClientProvider client={makeClient()}>
        <PoaDecisionStep
          agentId="agent-1"
          carrierRequests={[mkReq({})]}
          onContinue={() => {}}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("poa-accept-btn"));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ accepted: true });
    });
    await waitFor(() => {
      expect(mockSetLocation).toHaveBeenCalledWith("/sign/env-abc");
    });
  });

  it("clicking decline opens confirmation dialog then submits on confirm", async () => {
    const onContinue = vi.fn();
    mockMutateAsync.mockResolvedValueOnce({
      poaStatus: "opted_out",
      transitioned: 1,
      idempotent: false,
    });

    render(
      <QueryClientProvider client={makeClient()}>
        <PoaDecisionStep
          agentId="agent-1"
          carrierRequests={[mkReq({})]}
          onContinue={onContinue}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("poa-decline-btn"));
    // Confirm dialog visible.
    const confirmBtn = await screen.findByTestId("poa-decline-confirm");
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ accepted: false });
    });
    await waitFor(() => {
      expect(onContinue).toHaveBeenCalled();
    });
  });
});
