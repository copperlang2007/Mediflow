// @vitest-environment jsdom
/**
 * Render tests for the wizard's SigningStep. The step now creates an
 * e-sign envelope (POST /api/esign/envelopes) and navigates to the
 * `/sign/:envelopeId` window — we exercise that hand-off and the
 * empty/done states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  getGetCarriersQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { SigningStep } from "@/pages/onboarding/steps/SigningStep";
import type { CarrierContractingRequest } from "@/lib/onboarding/api";

function makeClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  qc.setQueryData(getGetCarriersQueryKey(), [
    { id: "c-aetna", name: "Aetna" },
    { id: "c-humana", name: "Humana" },
  ]);
  qc.setQueryData(getGetMeQueryKey(), {
    id: "user-1",
    orgId: "org-1",
    email: "agent@example.com",
    fullName: "Agent One",
    role: "agent",
    isActive: true,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  });
  return qc;
}

function mkReq(overrides: Partial<CarrierContractingRequest>): CarrierContractingRequest {
  return {
    id: "r-1",
    orgId: "org-1",
    onboardingRunId: "run-1",
    agentId: "agent-1",
    carrierId: "c-aetna",
    states: ["FL"],
    status: "paperwork_generated",
    paperworkDocumentId: "doc-1",
    signatureCompletedAt: null,
    lastStatusChangeAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function LocationProbe({ onLocation }: { onLocation: (loc: string) => void }) {
  const [loc] = useLocation();
  onLocation(loc);
  return null;
}

function renderStep(opts: {
  carrierRequests: CarrierContractingRequest[];
  onContinue?: () => void;
  onLocation?: (l: string) => void;
}) {
  const { hook } = memoryLocation({ path: "/onboarding", static: false });
  return render(
    <QueryClientProvider client={makeClient()}>
      <Router hook={hook}>
        <SigningStep
          agentId="agent-1"
          carrierRequests={opts.carrierRequests}
          onContinue={opts.onContinue ?? (() => {})}
        />
        {opts.onLocation && <LocationProbe onLocation={opts.onLocation} />}
      </Router>
    </QueryClientProvider>,
  );
}

describe("SigningStep", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/esign/envelopes")) {
        return new Response(
          JSON.stringify({
            envelopeId: "env-abc",
            status: "pending",
            signingUrl: "/sign/env-abc",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders an empty-state message when no carrier requests exist", () => {
    renderStep({ carrierRequests: [] });
    expect(screen.getByText(/Nothing to sign yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your admin will review your carrier selections/i),
    ).toBeInTheDocument();
  });

  it("shows a 'Sign now' button for carriers whose paperwork is ready", () => {
    renderStep({
      carrierRequests: [mkReq({ carrierId: "c-aetna" })],
    });
    const btn = screen.getByTestId("sign-btn-c-aetna");
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/Sign now/i);
  });

  it("does not render a Sign button for drafts", () => {
    renderStep({
      carrierRequests: [
        mkReq({ carrierId: "c-humana", status: "draft", paperworkDocumentId: null }),
      ],
    });
    expect(screen.queryByTestId("sign-btn-c-humana")).not.toBeInTheDocument();
  });

  it("clicking 'Sign now' calls the envelope-create endpoint and navigates to /sign/:envelopeId", async () => {
    let currentLocation = "/onboarding";
    renderStep({
      carrierRequests: [mkReq({ carrierId: "c-aetna" })],
      onLocation: (l) => {
        currentLocation = l;
      },
    });

    fireEvent.click(screen.getByTestId("sign-btn-c-aetna"));

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        calls.some((c) => String(c[0]).includes("/api/esign/envelopes")),
      ).toBe(true);
    });
    const esignCall = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) =>
      String(c[0]).includes("/api/esign/envelopes"),
    )!;
    expect(esignCall[0]).toContain("/api/esign/envelopes");
    const body = JSON.parse(esignCall[1].body as string);
    expect(body).toMatchObject({
      pdfDocumentId: "doc-1",
      carrierContractingRequestId: "r-1",
      signers: [
        { userId: "user-1", displayName: "Agent One", email: "agent@example.com" },
      ],
    });

    await waitFor(() => {
      expect(currentLocation).toBe("/sign/env-abc");
    });
  });

  it("does not start signing if the carrier paperwork is missing a document", async () => {
    renderStep({
      carrierRequests: [
        mkReq({
          carrierId: "c-aetna",
          status: "paperwork_generated",
          paperworkDocumentId: null,
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("sign-btn-c-aetna"));
    // Brief tick — no envelope-create call should be issued.
    await new Promise((r) => setTimeout(r, 0));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const esignCalls = calls.filter((c) =>
      String(c[0]).includes("/api/esign/envelopes"),
    );
    expect(esignCalls).toHaveLength(0);
  });

  it("shows the 'view summary' continue button only when all carriers have moved past paperwork_generated", () => {
    renderStep({
      carrierRequests: [
        mkReq({ id: "r-1", carrierId: "c-aetna", status: "signed" }),
        mkReq({ id: "r-2", carrierId: "c-humana", status: "submitted" }),
      ],
    });
    expect(screen.getByTestId("signing-continue")).toBeInTheDocument();
  });
});
