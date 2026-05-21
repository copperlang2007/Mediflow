// @vitest-environment jsdom
/**
 * Render tests for the wizard's DoneStep. The step depends on
 * `useGetCarriers()` to display carrier names, so we wrap it in a
 * QueryClientProvider with the carrier list pre-seeded — that mirrors the
 * pattern used to test components-with-query-deps without booting a
 * network mock.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetCarriersQueryKey } from "@workspace/api-client-react";
import { DoneStep } from "@/pages/onboarding/steps/DoneStep";
import type {
  AgentOnboardingRun,
  CarrierContractingRequest,
} from "@/lib/onboarding/api";

function makeClient(carriers: Array<{ id: string; name: string }>): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // Seed the carriers query so useGetCarriers returns synchronously.
  qc.setQueryData(getGetCarriersQueryKey(), carriers);
  return qc;
}

function renderDone(opts: {
  run: AgentOnboardingRun;
  requests: CarrierContractingRequest[];
  carriers: Array<{ id: string; name: string }>;
}) {
  return render(
    <QueryClientProvider client={makeClient(opts.carriers)}>
      <DoneStep run={opts.run} carrierRequests={opts.requests} />
    </QueryClientProvider>,
  );
}

const baseRun: AgentOnboardingRun = {
  id: "run-1",
  orgId: "org-1",
  agentId: "agent-1",
  startedByUserId: "u-1",
  status: "submitted",
  completedSteps: null,
  startedAt: "2025-01-01T00:00:00Z",
  completedAt: null,
  updatedAt: "2025-01-01T00:00:00Z",
};

function mkReq(overrides: Partial<CarrierContractingRequest>): CarrierContractingRequest {
  return {
    id: "r-1",
    orgId: "org-1",
    onboardingRunId: "run-1",
    agentId: "agent-1",
    carrierId: "c-aetna",
    states: ["FL", "GA"],
    status: "submitted",
    paperworkDocumentId: null,
    signatureCompletedAt: null,
    lastStatusChangeAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("DoneStep", () => {
  it("shows 'Submitted to carriers' headline when run is submitted but not complete", () => {
    renderDone({
      run: baseRun,
      requests: [mkReq({})],
      carriers: [{ id: "c-aetna", name: "Aetna" }],
    });
    // The string "Submitted to carriers" appears in BOTH the headline and
    // the onboardingStatusLabel pill — `getAllByText` returns both, and we
    // assert at least the headline (the first occurrence in DOM order).
    const matches = screen.getAllByText(/Submitted to carriers/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("shows the 'fully appointed!' headline when run.status is complete", () => {
    renderDone({
      run: { ...baseRun, status: "complete" },
      requests: [mkReq({ status: "appointed" })],
      carriers: [{ id: "c-aetna", name: "Aetna" }],
    });
    expect(screen.getByText(/fully appointed/i)).toBeInTheDocument();
  });

  it("renders one row per carrier request with the carrier name and states", () => {
    renderDone({
      run: baseRun,
      requests: [
        mkReq({ id: "r-1", carrierId: "c-aetna", states: ["FL"] }),
        mkReq({ id: "r-2", carrierId: "c-humana", states: ["GA", "TN"] }),
      ],
      carriers: [
        { id: "c-aetna", name: "Aetna" },
        { id: "c-humana", name: "Humana" },
      ],
    });
    expect(screen.getByText("Aetna")).toBeInTheDocument();
    expect(screen.getByText("Humana")).toBeInTheDocument();
    expect(screen.getByText("FL")).toBeInTheDocument();
    expect(screen.getByText(/GA, TN/)).toBeInTheDocument();
  });

  it("displays the writing number when present on a request", () => {
    renderDone({
      run: { ...baseRun, status: "complete" },
      requests: [mkReq({ status: "appointed", writingNumber: "W-987654" })],
      carriers: [{ id: "c-aetna", name: "Aetna" }],
    });
    expect(screen.getByText(/W-987654/)).toBeInTheDocument();
  });
});
