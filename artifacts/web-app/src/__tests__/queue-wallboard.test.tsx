// @vitest-environment jsdom
/**
 * Render/gate tests for the Queue Wallboard ("TV mode").
 *
 * The page reuses the live-queue read hooks (`useQueuePresence`,
 * `useRoutingStats`), which call `apiFetch` under the hood. We mock `fetch` so
 * the tests never cross the network, and seed `useGetMe` via the QueryClient
 * cache to exercise the super_admin / agency_admin role gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import QueueWallboardPage from "@/pages/queue-wallboard";

const ADMIN_USER = {
  id: "u-admin",
  orgId: "o-1",
  email: "admin@example.com",
  fullName: "Admin User",
  role: "agency_admin",
  isActive: true,
};

const NON_ADMIN_USER = { ...ADMIN_USER, id: "u-agent", role: "agent" };

function makeClient(user: typeof ADMIN_USER | null = ADMIN_USER): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (user) qc.setQueryData(getGetMeQueryKey(), user);
  return qc;
}

function renderPage(qc: QueryClient) {
  const { hook } = memoryLocation({ path: "/admin/queue/wall", static: true });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TooltipProvider>
          <QueueWallboardPage />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PRESENCE = {
  asOf: new Date().toISOString(),
  availableCount: 2,
  agents: [
    {
      agentId: "a-1",
      firstName: "Ada",
      lastName: "Lovelace",
      status: "available",
      lastSeenAt: new Date().toISOString(),
      expiresAt: null,
      availableNow: true,
    },
    {
      agentId: "a-2",
      firstName: "Alan",
      lastName: "Turing",
      status: "available",
      lastSeenAt: new Date().toISOString(),
      expiresAt: null,
      availableNow: true,
    },
    {
      agentId: "a-3",
      firstName: "Grace",
      lastName: "Hopper",
      status: "on_call",
      lastSeenAt: new Date().toISOString(),
      expiresAt: null,
      availableNow: false,
    },
  ],
};

const STATS = {
  asOf: new Date().toISOString(),
  sinceHours: 24,
  stats: {
    total: 10,
    routed: 8,
    noAgent: 2,
    routedRate: 0.8,
    avgCandidatePool: 3.2,
    byCarrier: [],
    byState: [],
  },
  coverageGaps: [
    {
      carrierId: "c-1",
      carrierName: "Acme Health",
      stateCode: "TX",
      noAgentCount: 2,
      lastOccurrence: new Date().toISOString(),
      availableNow: 0,
    },
  ],
};

/** Route a mocked fetch by URL to the right read endpoint payload. */
function routeFetch(url: string): Response {
  if (url.includes("/api/queue/presence")) return jsonResponse(PRESENCE);
  if (url.includes("/api/queue/routing/stats")) return jsonResponse(STATS);
  return jsonResponse({}, 404);
}

describe("QueueWallboardPage role gating", () => {
  it("renders a no-access panel for non-admin users", () => {
    renderPage(makeClient(NON_ADMIN_USER));
    expect(screen.getByTestId("wallboard-forbidden")).toBeInTheDocument();
    expect(screen.queryByTestId("wallboard")).not.toBeInTheDocument();
  });

  it("renders the wallboard for agency_admin", () => {
    renderPage(makeClient(ADMIN_USER));
    expect(screen.getByTestId("wallboard")).toBeInTheDocument();
    expect(screen.getByTestId("wallboard-clock")).toBeInTheDocument();
  });

  it("renders the wallboard for super_admin", () => {
    renderPage(makeClient({ ...ADMIN_USER, role: "super_admin" }));
    expect(screen.getByTestId("wallboard")).toBeInTheDocument();
    expect(screen.queryByTestId("wallboard-forbidden")).not.toBeInTheDocument();
  });

  it("excludes compliance_manager (default ADMIN_ROLES tier)", () => {
    renderPage(makeClient({ ...ADMIN_USER, role: "compliance_manager" }));
    expect(screen.getByTestId("wallboard-forbidden")).toBeInTheDocument();
  });
});

describe("QueueWallboardPage live data", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => Promise.resolve(routeFetch(String(url))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("shows the available count, available agents and coverage gaps", async () => {
    renderPage(makeClient(ADMIN_USER));

    await waitFor(() => {
      expect(screen.getByTestId("wallboard-available-count")).toHaveTextContent(
        "2",
      );
    });

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Alan Turing")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("wallboard-gaps")).toBeInTheDocument();
    });
    expect(screen.getByText("Acme Health")).toBeInTheDocument();
    expect(screen.getByText("TX")).toBeInTheDocument();
  });
});
