// @vitest-environment jsdom
/**
 * Render tests for the wizard's ReviewStep. We seed `useGetCarriers` via
 * the QueryClient so the step renders deterministic carrier names.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetCarriersQueryKey } from "@workspace/api-client-react";
import { ReviewStep } from "@/pages/onboarding/steps/ReviewStep";
import type {
  AgentContractingProfile,
  CarrierContractingRequest,
} from "@/lib/onboarding/api";

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

function mkProfile(overrides: Partial<AgentContractingProfile> = {}): AgentContractingProfile {
  return {
    orgId: "org-1",
    agentId: "agent-1",
    ssn: "123-45-6789",
    ein: null,
    dob: "1990-01-15",
    homeAddressLine1: "1 Main St",
    homeAddressLine2: null,
    homeCity: "Miami",
    homeState: "FL",
    homeZip: "33101",
    mailingSameAsHome: true,
    mailingAddressLine1: null,
    mailingAddressLine2: null,
    mailingCity: null,
    mailingState: null,
    mailingZip: null,
    phone: "555-1234",
    email: "agent@example.com",
    entityType: "individual",
    businessName: null,
    eAndOCarrier: "Acme E&O",
    eAndOPolicyNumber: "POL-9",
    eAndOExpiresOn: "2026-12-31",
    ...overrides,
  };
}

function mkReq(overrides: Partial<CarrierContractingRequest>): CarrierContractingRequest {
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

describe("ReviewStep", () => {
  it("renders the agent's profile fields", () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <ReviewStep
          agentId="agent-1"
          profile={mkProfile()}
          carrierRequests={[mkReq({})]}
          onBack={() => {}}
          onContinue={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("agent@example.com")).toBeInTheDocument();
    expect(screen.getByText("555-1234")).toBeInTheDocument();
    expect(screen.getByText("Acme E&O")).toBeInTheDocument();
  });

  it("filters out cancelled carrier requests from the carrier list", () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <ReviewStep
          agentId="agent-1"
          profile={mkProfile()}
          carrierRequests={[
            mkReq({ id: "r-1", carrierId: "c-aetna", status: "draft" }),
            mkReq({ id: "r-2", carrierId: "c-humana", status: "cancelled" }),
          ]}
          onBack={() => {}}
          onContinue={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Aetna")).toBeInTheDocument();
    expect(screen.queryByText("Humana")).not.toBeInTheDocument();
    // Header reflects the active count (1), not the total (2).
    expect(screen.getByText(/Carrier selections \(1\)/)).toBeInTheDocument();
  });

  it("fires onContinue when 'Submit for admin review' is clicked", () => {
    const onContinue = vi.fn();
    render(
      <QueryClientProvider client={makeClient()}>
        <ReviewStep
          agentId="agent-1"
          profile={mkProfile()}
          carrierRequests={[mkReq({})]}
          onBack={() => {}}
          onContinue={onContinue}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText(/Submit for admin review/i));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("shows an empty-state message when no active carrier requests exist", () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <ReviewStep
          agentId="agent-1"
          profile={mkProfile()}
          carrierRequests={[]}
          onBack={() => {}}
          onContinue={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/No carriers selected/i)).toBeInTheDocument();
  });
});
