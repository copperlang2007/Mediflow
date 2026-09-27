// @vitest-environment jsdom
/**
 * Render tests for the stage2/portal-dialer pages: Client Portal preview,
 * Softphone, Supervisor and Quoting. `fetch` is mocked per URL; `useGetMe`
 * is seeded through the QueryClient cache to drive the role gates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import ClientPortalPage, { nextRenewal } from "@/pages/ClientPortalPage";
import DialerPage, { describeFailure } from "@/pages/DialerPage";
import SupervisorPage from "@/pages/SupervisorPage";
import QuotingPage from "@/pages/QuotingPage";
import { normalizeAppointments } from "@/lib/portalDialer/api";

const ADMIN = { id: "u-admin", orgId: "o-1", email: "a@example.com", fullName: "Admin", role: "agency_admin", isActive: true };
const AGENT = { ...ADMIN, id: "u-agent", role: "agent" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderAt(path: string, el: React.ReactElement, user = ADMIN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(getGetMeQueryKey(), user);
  const [pathname, search = ""] = path.split("?");
  const { hook, searchHook } = memoryLocation({ path: pathname, searchPath: search, static: true } as never) as unknown as {
    hook: never; searchHook: never;
  };
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <TooltipProvider>{el}</TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

const PREVIEW = {
  contact: {
    id: "c-1", firstName: "Joan", lastName: "Park", email: "joan@example.com", phone: "+15035551234",
    status: "enrolled", city: "Portland", stateCode: "OR", zipCode: "97201", preferredLanguage: null,
    currentPlanType: "MAPD", optOutSms: false, optOutEmail: false,
  },
  plans: [{
    id: "e-1", carrierId: "car-1", carrierName: "Acme Health", planId: null, planName: "Acme Advantage",
    planType: "MAPD", planYear: 2026, effectiveDate: "2026-01-01", disenrolledDate: null, status: "active",
    agentId: "a-1", agentFirstName: "Sam", agentLastName: "Rivera",
  }],
  messages: [
    { id: "m-1", channel: "sms", direction: "outbound", subject: null, body: "Hi Joan, time for a review?", status: "sent", sentAt: null, createdAt: "2026-03-01T10:00:00Z" },
    { id: "m-2", channel: "sms", direction: "inbound", subject: null, body: "Yes please", status: "received", sentAt: null, createdAt: "2026-03-02T10:00:00Z" },
  ],
  documents: [{ id: "d-1", name: "SOA.pdf", category: "soa", mimeType: null, fileSizeBytes: null, createdAt: "2026-03-01T10:00:00Z" }],
  agent: { id: "a-1", firstName: "Sam", lastName: "Rivera", email: "sam@agency.test", phone: "+15035550000" },
  permissions: { canReplySms: true, canReplyEmail: true },
  asOf: "2026-03-05T10:00:00Z",
};

let routes: Record<string, (url: string) => Response>;

beforeEach(() => {
  routes = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return hit ? routes[hit](url) : json({ error: "not found" }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Client Portal page", () => {
  it("prompts for a client when none is picked", () => {
    renderAt("/client-portal", <ClientPortalPage />);
    expect(screen.getByText(/Client logins are coming soon/)).toBeInTheDocument();
    expect(screen.getByText("Pick a client to preview")).toBeInTheDocument();
  });

  it("renders the member's real plan, messages, documents and agent", async () => {
    routes["/api/client-portal/preview/c-1"] = () => json(PREVIEW);
    renderAt("/client-portal?contact=c-1", <ClientPortalPage />);
    expect(await screen.findByText("Acme Advantage")).toBeInTheDocument();
    expect(screen.getByText("Hi Joan, time for a review?")).toBeInTheDocument();
    expect(screen.getByText("SOA.pdf")).toBeInTheDocument();
    expect(screen.getByText("Plan year renews")).toBeInTheDocument();
    expect(screen.getByText("Jan 1, 2027")).toBeInTheDocument();
    // No appointments API in this build -> honest coming-soon copy.
    await waitFor(() => expect(screen.getByText(/Appointment booking is coming soon/)).toBeInTheDocument());
  });

  it("shows a no-access panel for roles without contact:read", () => {
    renderAt("/client-portal", <ClientPortalPage />, AGENT);
    expect(screen.getByText(/don't have access to the client portal preview/)).toBeInTheDocument();
  });
});

describe("Softphone page", () => {
  it("renders the dial pad and honest browser-calling note", async () => {
    routes["/api/softphone/recent-calls"] = () => json({ data: [], total: 0 });
    routes["/api/softphone/dispositions"] = () => json({ data: [{ code: "FOLLOW_UP", label: "Call back / follow up" }] });
    renderAt("/dialer", <DialerPage />);
    expect(screen.getByText("Dial Pad")).toBeInTheDocument();
    expect(screen.getByText(/Browser calling: coming soon/)).toBeInTheDocument();
    expect(await screen.findByText("No calls logged yet")).toBeInTheDocument();
    expect(screen.queryByText(/00:00/)).not.toBeInTheDocument();
  });
});

describe("Supervisor page", () => {
  it("shows live presence and the coming-soon note", async () => {
    routes["/api/queue/presence"] = () => json({
      asOf: new Date().toISOString(), availableCount: 1,
      agents: [{ agentId: "a-1", firstName: "Sam", lastName: "Rivera", status: "available", lastSeenAt: new Date().toISOString(), expiresAt: null, availableNow: true }],
    });
    routes["/api/queue/routing/stats"] = () => json({ stats: { total: 0, routed: 0, noAgent: 0, routedRate: 0, avgCandidatePool: 0, byCarrier: [], byState: [] }, coverageGaps: [], sinceHours: 24, asOf: new Date().toISOString() });
    routes["/api/queue/routing/recent"] = () => json({ data: [], total: 0 });
    routes["/api/queue/callbacks"] = () => json({ data: [], total: 0 });
    renderAt("/supervisor", <SupervisorPage />);
    expect(await screen.findByText("Sam Rivera")).toBeInTheDocument();
    expect(screen.getByText(/Listen-in, whisper, barge/)).toBeInTheDocument();
  });

  it("is supervisor-only", () => {
    renderAt("/supervisor", <SupervisorPage />, { ...ADMIN, role: "agent_support" });
    expect(screen.getByText(/don't have access to the supervisor dashboard/)).toBeInTheDocument();
  });
});

describe("Quoting page", () => {
  it("never shows sample plans and lists real carriers", async () => {
    routes["/api/carriers"] = () => json([{ id: "car-1", name: "Acme Health", cmsContractNumber: "H1234", isActive: true }]);
    renderAt("/quoting", <QuotingPage />);
    expect(screen.getByText("Plan data isn't connected yet")).toBeInTheDocument();
    expect(await screen.findByText("Acme Health")).toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("nextRenewal: plan year for MA/PDP, anniversary for Medigap, none when ended", () => {
    const today = new Date(2026, 4, 10);
    expect(nextRenewal({ planType: "MAPD", planYear: 2026, effectiveDate: "2026-01-01", status: "active" }, today)?.date)
      .toEqual(new Date(2027, 0, 1));
    expect(nextRenewal({ planType: "supp", planYear: 2025, effectiveDate: "2025-08-15", status: "active" }, today)?.date)
      .toEqual(new Date(2026, 7, 15));
    expect(nextRenewal({ planType: "MA", planYear: 2025, effectiveDate: "2025-01-01", status: "terminated" }, today)).toBeNull();
  });

  it("describeFailure explains checks in plain words", () => {
    const p = { agent: { id: "a", name: "Sam Rivera", source: "assigned" as const }, planYear: 2026, callingHours: { startHour: 8, endHour: 21, timezone: "America/New_York", localTime: "10:14 PM" } };
    expect(describeFailure({ code: "AGENT_NOT_LICENSED", detail: "" }, p, "FL")).toBe("Sam Rivera has no active FL license.");
    expect(describeFailure({ code: "OUTSIDE_CALLING_HOURS", detail: "" }, p)).toMatch(/10:14 PM.*8am–9pm/);
  });

  it("normalizeAppointments keeps future, non-cancelled items in order", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const out = normalizeAppointments({ data: [
      { id: "2", title: "Review", startsAt: "2026-04-01T10:00:00Z" },
      { id: "1", type: "Plan review", startAt: "2026-03-15T10:00:00Z" },
      { id: "0", title: "Old", startsAt: "2026-02-01T10:00:00Z" },
      { id: "x", title: "Cancelled", startsAt: "2026-03-20T10:00:00Z", status: "cancelled" },
    ] }, now);
    expect(out.map((a) => a.id)).toEqual(["1", "2"]);
    expect(out[0].title).toBe("Plan review");
  });
});
