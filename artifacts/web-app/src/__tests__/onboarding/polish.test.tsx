// @vitest-environment jsdom
/**
 * Polish tests covering loading skeletons, empty states, mobile-responsive
 * class wiring, and the integrity-hash-as-tooltip pattern on the sign page.
 *
 * These exercises ride on top of the existing sign-page.test.tsx / *Step.test.tsx
 * coverage; they target the demo-prep visual fixes specifically (skeleton
 * shape, empty-state copy, responsive class names, error surfacing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getGetCarriersQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import SignPage from "@/pages/sign";
import { SigningStep } from "@/pages/onboarding/steps/SigningStep";

// Minimal FakeCanvasCtx so signature_pad doesn't crash under jsdom.
class FakeCanvasCtx {
  scale() {}
  fillRect() {}
  clearRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  fill() {}
  arc() {}
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  setTransform() {}
  drawImage() {}
  getImageData() {
    return { data: new Uint8ClampedArray(4) };
  }
  putImageData() {}
  createImageData() {
    return { data: new Uint8ClampedArray(4) };
  }
}

beforeEach(() => {
  // ResizeObserver isn't implemented in jsdom but radix uses it.
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // signature_pad needs a 2D context.
  HTMLCanvasElement.prototype.getContext = function () {
    return new FakeCanvasCtx() as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement["getContext"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- Sign page — loading skeleton + tooltip-hash ---------------------------

const ENVELOPE_ID = "env-polish-1";
const PENDING_ENVELOPE = {
  envelopeId: ENVELOPE_ID,
  status: "pending" as const,
  carrierContractingRequestId: "r-1",
  pdfDocumentId: "doc-1",
  signers: [
    { userId: "user-1", displayName: "Agent One", email: "agent@example.com" },
  ],
  signedAt: null,
  signedPdfDocumentId: null,
  integritySha256: null,
  consentRecord: null,
};

const COMPLETED_ENVELOPE = {
  ...PENDING_ENVELOPE,
  status: "completed" as const,
  signedAt: "2025-05-22T15:32:00Z",
  signedPdfDocumentId: "signed-doc-1",
  integritySha256:
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
};

function makeQc(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderSignPage(envelopePath: string, qc: QueryClient = makeQc()) {
  const { hook } = memoryLocation({ path: envelopePath, static: false });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TooltipProvider>
          <Route path="/sign/:envelopeId" component={SignPage} />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

describe("sign page polish", () => {
  it("renders a layout-matching skeleton while the envelope is loading", async () => {
    // Hang the fetch so isLoading stays true.
    let release: ((v: Response) => void) | null = null;
    const pending = new Promise<Response>((res) => {
      release = res;
    });
    globalThis.fetch = vi.fn(() => pending) as unknown as typeof fetch;

    renderSignPage(`/sign/${ENVELOPE_ID}`);
    expect(await screen.findByTestId("sign-loading")).toBeInTheDocument();
    // Resolve the request so React Query unsubscribes cleanly.
    release?.(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("renders the integrity-hash behind a disclosure (not the headline) on completion", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(COMPLETED_ENVELOPE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    renderSignPage(`/sign/${ENVELOPE_ID}`);

    // The headline is now "You're done with this carrier" — the hash is
    // tucked into a <details> disclosure.
    expect(
      await screen.findByText(/You're done with this carrier/i),
    ).toBeInTheDocument();
    const trigger = screen.getByTestId("integrity-hash-trigger");
    expect(trigger.textContent).toMatch(/Integrity hash/i);
    // Trigger is a <summary>, parent is the <details> element.
    expect(trigger.closest("details")).not.toBeNull();
  });

  it("renders the Back-to-onboarding CTA with mobile-stacking classes", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(COMPLETED_ENVELOPE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    renderSignPage(`/sign/${ENVELOPE_ID}`);

    const back = await screen.findByTestId("return-to-onboarding");
    // Stacks full-width on mobile, auto on sm+.
    expect(back.className).toContain("w-full");
    expect(back.className).toMatch(/sm:w-auto/);
  });

  it("shows the Beta badge in the header (not in the body copy)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(PENDING_ENVELOPE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    renderSignPage(`/sign/${ENVELOPE_ID}`);

    const badge = await screen.findByTestId("beta-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/Beta/);
    // Confirm badge sits in the header (its closest semantic ancestor).
    expect(badge.closest("header")).not.toBeNull();
  });
});

// ---- Signing step — skeleton + empty state ---------------------------------

function makeWizardClient(includeCarriers: boolean): QueryClient {
  const qc = makeQc();
  if (includeCarriers) {
    qc.setQueryData(getGetCarriersQueryKey(), [
      { id: "c-aetna", name: "Aetna" },
    ]);
  }
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

function renderSigningStep(opts: {
  carrierRequests: Array<Record<string, unknown>>;
  includeCarriers?: boolean;
}) {
  const { hook } = memoryLocation({ path: "/onboarding", static: false });
  return render(
    <QueryClientProvider client={makeWizardClient(opts.includeCarriers ?? true)}>
      <Router hook={hook}>
        <SigningStep
          agentId="agent-1"
          carrierRequests={
            opts.carrierRequests as Parameters<typeof SigningStep>[0]["carrierRequests"]
          }
          onContinue={() => {}}
        />
      </Router>
    </QueryClientProvider>,
  );
}

describe("SigningStep polish", () => {
  it("renders a friendly empty state — no longer a blank card", () => {
    renderSigningStep({ carrierRequests: [] });
    expect(screen.getByText(/Nothing to sign yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your admin will review your carrier selections/i),
    ).toBeInTheDocument();
  });
});

// ---- Onboarding wizard — loading skeleton ----------------------------------

describe("onboarding wizard polish", () => {
  it("loading skeleton has the step-pill skeleton row matching final layout", async () => {
    const qc = makeQc();
    // Don't seed useGetMe — the page goes into its meLoading branch.
    const { hook } = memoryLocation({ path: "/onboarding", static: false });
    const { default: OnboardingPage } = await import("@/pages/onboarding");
    // Hang the /me fetch so the loading branch sticks. We use vi.fn that
    // returns a never-resolving promise.
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;
    await act(async () => {
      render(
        <QueryClientProvider client={qc}>
          <Router hook={hook}>
            <OnboardingPage />
          </Router>
        </QueryClientProvider>,
      );
    });
    const loading = await screen.findByTestId("onboarding-loading");
    expect(loading).toBeInTheDocument();
    // Several pill-shaped skeletons rendered (one per wizard step).
    const skeletons = loading.querySelectorAll("[data-slot=skeleton], .animate-pulse");
    expect(skeletons.length).toBeGreaterThanOrEqual(6);
  });
});
