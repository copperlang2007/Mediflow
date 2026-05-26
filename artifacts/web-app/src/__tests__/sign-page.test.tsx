// @vitest-environment jsdom
/**
 * Render tests for the in-house signing window at /sign/:envelopeId.
 *
 * The page makes one GET (`/api/esign/envelopes/:id`) on mount and one POST
 * (`/api/esign/envelopes/:id/sign`) on submit. We stub `fetch` at the
 * module level so the React Query in-flight machinery doesn't try to hit a
 * real network during tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import SignPage from "@/pages/sign";

const ENVELOPE_ID = "env-1";
const ENVELOPE_FIXTURE = {
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

// signature_pad references HTMLCanvasElement APIs (getContext etc.).
// jsdom stubs getContext to return null by default, which would crash
// the `new SignaturePad(canvas)` constructor. We provide a barest-bones
// fake context so the constructor is happy. We never actually need pixel
// data in the tests below — the "Draw" tab is not exercised.
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
  setLineDash() {}
  fillText() {}
  measureText() {
    return { width: 0 };
  }
}

function installCanvasShim() {
  // jsdom may already provide a noop; we replace with one that returns a
  // ctx so signature_pad's listeners attach successfully.
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return new FakeCanvasCtx() as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement["getContext"];
}

function setupFetchMock(opts: {
  envelope?: typeof ENVELOPE_FIXTURE;
  signResponse?: unknown;
  signStatus?: number;
}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url.includes(`/api/esign/envelopes/${ENVELOPE_ID}/sign`)) {
      const status = opts.signStatus ?? 200;
      const body =
        opts.signResponse ?? {
          envelopeId: ENVELOPE_ID,
          status: "completed",
          signedPdfDocumentId: "doc-signed-1",
          integritySha256: "abc123def456",
        };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes(`/api/esign/envelopes/${ENVELOPE_ID}`)) {
      return new Response(JSON.stringify(opts.envelope ?? ENVELOPE_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

function renderPage() {
  const { hook } = memoryLocation({
    path: `/sign/${ENVELOPE_ID}`,
    static: false,
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const result = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Router hook={hook}>
          <Route path="/sign/:envelopeId" component={SignPage} />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...result, hook };
}

async function waitForEnvelopeLoaded() {
  await waitFor(() => {
    expect(screen.getByTestId("sign-page")).toBeInTheDocument();
  });
}

describe("SignPage", () => {
  const originalFetch = globalThis.fetch;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    installCanvasShim();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it("renders the 'Beta' label prominently in the header", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();
    const badge = screen.getByTestId("beta-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/beta/i);
    expect(screen.getByText(/Mediflow E-Sign/i)).toBeInTheDocument();
  });

  it("disables 'Sign and complete' until prerequisites are met", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();
    expect(screen.getByTestId("submit-sign")).toBeDisabled();
  });

  it("requires all three consent boxes to enable the submit button", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();

    // Scroll-confirm + typed name first.
    fireEvent.click(screen.getByTestId("scroll-confirm"));
    fireEvent.change(screen.getByTestId("typed-name"), {
      target: { value: "Agent One" },
    });

    // Only 2/3 consents — still disabled.
    fireEvent.click(screen.getByTestId("consent-electronic"));
    fireEvent.click(screen.getByTestId("consent-understood"));
    expect(screen.getByTestId("submit-sign")).toBeDisabled();

    // All three — now enabled.
    fireEvent.click(screen.getByTestId("consent-paper-copy"));
    expect(screen.getByTestId("submit-sign")).not.toBeDisabled();
  });

  it("gates the submit button on a non-empty typed name", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();

    fireEvent.click(screen.getByTestId("scroll-confirm"));
    fireEvent.click(screen.getByTestId("consent-electronic"));
    fireEvent.click(screen.getByTestId("consent-understood"));
    fireEvent.click(screen.getByTestId("consent-paper-copy"));

    expect(screen.getByTestId("submit-sign")).toBeDisabled();
    fireEvent.change(screen.getByTestId("typed-name"), {
      target: { value: "Agent One" },
    });
    expect(screen.getByTestId("submit-sign")).not.toBeDisabled();
  });

  it("disables consent boxes until the user has confirmed scrolling the PDF", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();
    expect(screen.getByTestId("consent-electronic")).toBeDisabled();
    fireEvent.click(screen.getByTestId("scroll-confirm"));
    expect(screen.getByTestId("consent-electronic")).not.toBeDisabled();
  });

  it("submits the sign request with the expected body and shows the confirmation screen", async () => {
    const calls = setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();

    fireEvent.click(screen.getByTestId("scroll-confirm"));
    fireEvent.click(screen.getByTestId("consent-electronic"));
    fireEvent.click(screen.getByTestId("consent-understood"));
    fireEvent.click(screen.getByTestId("consent-paper-copy"));
    fireEvent.change(screen.getByTestId("typed-name"), {
      target: { value: "Agent One" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-sign"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("sign-confirmation")).toBeInTheDocument();
    });

    const signCall = calls.find((c) =>
      c.url.includes(`/api/esign/envelopes/${ENVELOPE_ID}/sign`),
    );
    expect(signCall).toBeDefined();
    const body = JSON.parse(signCall!.init!.body as string);
    expect(body).toMatchObject({
      typedName: "Agent One",
      consentToElectronicBusiness: true,
      intentToSign: true,
    });
    expect(body.signatureSvg).toMatch(/<svg/);
    // Audit fields (ip/user-agent) must NOT be sent from the client.
    expect(body).not.toHaveProperty("ipAddress");
    expect(body).not.toHaveProperty("userAgent");

    // Integrity hash now lives behind a <details> disclosure so it doesn't
    // dominate the confirmation copy. The element is still in the DOM
    // (jsdom doesn't gate `display` on `<details>` content), so we can
    // assert against it directly.
    expect(screen.getByTestId("integrity-hash-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("integrity-hash").textContent).toBe(
      "abc123def456",
    );
    expect(screen.getByTestId("download-signed-pdf")).toBeInTheDocument();
  });

  it("shows an error message and keeps the form filled in when the API returns 4xx", async () => {
    setupFetchMock({
      signResponse: { error: "Envelope already completed" },
      signStatus: 409,
    });
    renderPage();
    await waitForEnvelopeLoaded();

    fireEvent.click(screen.getByTestId("scroll-confirm"));
    fireEvent.click(screen.getByTestId("consent-electronic"));
    fireEvent.click(screen.getByTestId("consent-understood"));
    fireEvent.click(screen.getByTestId("consent-paper-copy"));
    fireEvent.change(screen.getByTestId("typed-name"), {
      target: { value: "Agent One" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-sign"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("submit-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("submit-error").textContent).toMatch(
      /already completed/i,
    );
    // Form state preserved — user can retry.
    expect(
      (screen.getByTestId("typed-name") as HTMLInputElement).value,
    ).toBe("Agent One");
  });

  it("renders the PDF viewer iframe pointing at the document download URL", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();
    const iframe = screen.getByTestId("pdf-viewer") as HTMLIFrameElement;
    expect(iframe.src).toContain("/api/documents/doc-1/download");
  });

  it("if the envelope is already completed on load, jumps straight to the confirmation view", async () => {
    setupFetchMock({
      envelope: {
        ...ENVELOPE_FIXTURE,
        status: "completed",
        signedPdfDocumentId: "doc-signed-1",
        integritySha256: "preexisting-hash",
      },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("sign-confirmation")).toBeInTheDocument();
    });
    expect(screen.getByTestId("integrity-hash-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("integrity-hash").textContent).toBe(
      "preexisting-hash",
    );
  });

  it("shows an error card when the envelope fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
    }) as unknown as typeof fetch;
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("sign-error")).toBeInTheDocument();
    });
  });

  it("renders a typed-signature preview when the user types in the name field", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();
    fireEvent.change(screen.getByTestId("typed-name"), {
      target: { value: "Agent One" },
    });
    const preview = screen.getByTestId("typed-preview");
    expect(preview.textContent).toContain("Agent One");
  });

  it("exposes an aria-label on the signature canvas when on the Draw tab", async () => {
    setupFetchMock({});
    renderPage();
    await waitForEnvelopeLoaded();
    // Radix Tabs activates on pointerdown (mousedown). fireEvent.click is a
    // bare click event — the Radix internal event is mousedown for keyboard
    // a11y interop. We dispatch both to be safe.
    const drawTab = screen.getByTestId("mode-draw");
    await act(async () => {
      fireEvent.pointerDown(drawTab);
      fireEvent.mouseDown(drawTab);
      fireEvent.click(drawTab);
      drawTab.focus();
    });
    await waitFor(() => {
      const canvas = screen.getByTestId("signature-canvas");
      expect(canvas).toHaveAttribute("aria-label", "Signature drawing canvas");
    });
  });
});
