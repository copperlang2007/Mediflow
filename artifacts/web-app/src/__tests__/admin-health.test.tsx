// @vitest-environment jsdom
/**
 * Component tests for the admin System Health page.
 *
 * The page renders an admin-gated card that calls
 * `GET /api/admin/health/ai` via `apiFetch`. We mock `fetch` so the test
 * never crosses the network, and seed `useGetMe` via the QueryClient cache
 * to exercise the role gate.
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
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import AdminHealthPage, {
  AiProviderCard,
  normalizeResult,
  type AiHealthResult,
} from "@/pages/admin-health";

const ADMIN_USER = {
  id: "u-admin",
  orgId: "o-1",
  email: "admin@example.com",
  fullName: "Admin User",
  role: "agency_admin",
  isActive: true,
};

const NON_ADMIN_USER = {
  id: "u-agent",
  orgId: "o-1",
  email: "agent@example.com",
  fullName: "Agent User",
  role: "agent",
  isActive: true,
};

function makeClient(user: typeof ADMIN_USER | typeof NON_ADMIN_USER | null = ADMIN_USER): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (user) qc.setQueryData(getGetMeQueryKey(), user);
  return qc;
}

function renderPage(qc: QueryClient) {
  const { hook } = memoryLocation({ path: "/admin/health", static: true });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TooltipProvider>
          <AdminHealthPage />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

function renderCard() {
  const qc = makeClient(ADMIN_USER);
  const { hook } = memoryLocation({ path: "/admin/health", static: true });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TooltipProvider>
          <AiProviderCard />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

const HEALTH_OK: AiHealthResult = {
  provider: "azure",
  configured: true,
  envValid: true,
  envIssues: [],
  ping: { ok: true, latencyMs: 142, model: "gpt-4o-mini" },
  warnings: [],
};

const HEALTH_AUTH_FAIL: AiHealthResult = {
  provider: "openai",
  configured: true,
  envValid: true,
  envIssues: [],
  ping: {
    ok: false,
    category: "auth_failed",
    message: "Upstream rejected the API key (401/403)",
  },
  warnings: [],
};

const HEALTH_ENV_ISSUES: AiHealthResult = {
  provider: "unset",
  configured: false,
  envValid: false,
  envIssues: [
    "AI_INTEGRATIONS_PROVIDER missing",
    "AI_INTEGRATIONS_OPENAI_API_KEY missing",
  ],
  ping: {
    ok: false,
    category: "unknown",
    message: "AI provider not configured — see envIssues",
  },
  warnings: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AdminHealthPage role gating", () => {
  it("renders a forbidden panel for non-admin users", () => {
    renderPage(makeClient(NON_ADMIN_USER));
    expect(screen.getByTestId("admin-health-forbidden")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-health-card")).not.toBeInTheDocument();
  });

  it("renders the AI provider card for agency_admin", () => {
    renderPage(makeClient(ADMIN_USER));
    expect(screen.getByTestId("ai-health-card")).toBeInTheDocument();
    expect(screen.getByTestId("ai-health-test-btn")).toBeInTheDocument();
  });

  it("renders the AI provider card for super_admin", () => {
    renderPage(makeClient({ ...ADMIN_USER, role: "super_admin" }));
    expect(screen.getByTestId("ai-health-card")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-health-forbidden")).not.toBeInTheDocument();
  });
});

describe("AiProviderCard fetch + render", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("calls GET /api/admin/health/ai and renders a successful ping", async () => {
    fetchMock.mockResolvedValue(jsonResponse(HEALTH_OK));

    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-health-test-btn"));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/admin\/health\/ai$/);
    // The endpoint is GET — apiFetch defaults to GET (no `method` in init).
    expect((init as RequestInit | undefined)?.method).toBeUndefined();
    expect((init as RequestInit).credentials).toBe("include");

    expect(await screen.findByTestId("ai-health-result")).toBeInTheDocument();
    expect(screen.getByTestId("ai-health-provider-badge")).toHaveTextContent(
      "azure",
    );
    expect(screen.getByTestId("ai-health-ping-ok")).toHaveTextContent(
      /OK in 142ms/,
    );
    expect(screen.getByTestId("ai-health-ping-ok")).toHaveTextContent(
      /gpt-4o-mini/,
    );
    // After a run, the Refresh button replaces the initial Test button.
    expect(screen.getByTestId("ai-health-refresh-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-health-test-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-health-checked-at")).toBeInTheDocument();
  });

  it("renders the error category + message inline when the ping fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse(HEALTH_AUTH_FAIL));

    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-health-test-btn"));
    });

    expect(await screen.findByTestId("ai-health-ping-fail")).toHaveTextContent(
      /Authentication failed/,
    );
    expect(screen.getByTestId("ai-health-ping-fail")).toHaveTextContent(
      /Upstream rejected the API key/,
    );
    // Provider badge still rendered for context.
    expect(screen.getByTestId("ai-health-provider-badge")).toHaveTextContent(
      "openai",
    );
  });

  it("renders envIssues as red bullets when present", async () => {
    fetchMock.mockResolvedValue(jsonResponse(HEALTH_ENV_ISSUES));

    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-health-test-btn"));
    });

    await screen.findByTestId("ai-health-env-issues");
    expect(screen.getByTestId("ai-health-env-issue-0")).toHaveTextContent(
      "AI_INTEGRATIONS_PROVIDER missing",
    );
    expect(screen.getByTestId("ai-health-env-issue-1")).toHaveTextContent(
      "AI_INTEGRATIONS_OPENAI_API_KEY missing",
    );
    expect(screen.getByTestId("ai-health-provider-badge")).toHaveTextContent(
      "unset",
    );
  });

  it("surfaces a top-level fetch error when the request 5xxes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "internal server error" }, 500),
    );

    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-health-test-btn"));
    });

    expect(
      await screen.findByTestId("ai-health-fetch-error"),
    ).toHaveTextContent(/internal server error/);
    // No result rendered when the request itself failed.
    expect(screen.queryByTestId("ai-health-result")).not.toBeInTheDocument();
  });

  it("Refresh re-runs the probe after the first call", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(HEALTH_AUTH_FAIL))
      .mockResolvedValueOnce(jsonResponse(HEALTH_OK));

    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-health-test-btn"));
    });
    await screen.findByTestId("ai-health-ping-fail");

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-health-refresh-btn"));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId("ai-health-ping-ok")).toBeInTheDocument();
  });
});

describe("normalizeResult", () => {
  it("coerces an empty/garbage response to a safe defaulted shape", () => {
    const r = normalizeResult({});
    expect(r.provider).toBe("unset");
    expect(r.configured).toBe(false);
    expect(r.envValid).toBe(false);
    expect(r.envIssues).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ping.ok).toBe(false);
  });

  it("only keeps documented ping fields and drops unknown keys", () => {
    const r = normalizeResult({
      provider: "azure",
      configured: true,
      envValid: true,
      envIssues: ["x", 42, "y"],
      ping: {
        ok: true,
        latencyMs: 17,
        model: "gpt-x",
        category: "unknown",
        secretKey: "sk-leak",
      },
      warnings: ["warn-a"],
      extraField: "should-not-render",
    });
    expect(r.envIssues).toEqual(["x", "y"]);
    expect(r.ping.latencyMs).toBe(17);
    expect(r.ping.model).toBe("gpt-x");
    expect((r.ping as unknown as Record<string, unknown>).secretKey).toBeUndefined();
    expect((r as unknown as Record<string, unknown>).extraField).toBeUndefined();
  });

  it("drops unknown ping categories", () => {
    const r = normalizeResult({
      provider: "openai",
      ping: { ok: false, category: "definitely-fake", message: "boom" },
    });
    expect(r.ping.category).toBeUndefined();
    expect(r.ping.message).toBe("boom");
  });
});
