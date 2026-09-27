// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PipelineTab from "@/pages/crm/PipelineTab";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const STAGES = [
  { id: "st-new", pipelineId: "p1", name: "New Lead", orderIndex: 0, color: "#94a3b8", probabilityPct: 10, createdAt: "2026-01-01T00:00:00Z" },
  { id: "st-enrolled", pipelineId: "p1", name: "Enrolled", orderIndex: 1, color: "#22c55e", probabilityPct: 100, createdAt: "2026-01-01T00:00:00Z" },
];

function deal(id: string, stageId: string, status: "open" | "won" | "lost", first: string, value: number, extra: Record<string, unknown> = {}) {
  return {
    deal: {
      id, stageId, contactId: `c-${id}`, title: `Deal ${id}`, valueEst: value, status,
      lostReason: null, wonAt: status === "won" ? "2026-05-10T00:00:00Z" : null,
      lostAt: status === "lost" ? "2026-05-11T00:00:00Z" : null,
      updatedAt: "2026-09-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", ...extra,
    },
    contactFirstName: first,
    contactLastName: "Test",
  };
}

const DEALS = [
  deal("d1", "st-new", "open", "Olive", 1000),
  // Won deals keep whatever stage they were in; they must still be shown
  // under the finish stage so "Won deals" and "Enrolled" agree.
  deal("d2", "st-enrolled", "won", "Wanda", 1500),
  deal("d3", "st-new", "won", "Walter", 500),
  deal("d4", "st-new", "lost", "Lou", 700, { lostReason: "Kept current plan" }),
];

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/analytics")) {
      return ok({ totalDeals: 4, wonDeals: 2, lostDeals: 1, openDeals: 1, conversionRate: 50, openValueTotal: 1000, wonValueTotal: 2000, lostValueTotal: 700 });
    }
    if (url.includes("/api/pipelines")) {
      return ok([{ id: "p1", orgId: "o1", name: "Medicare AEP", description: null, isDefault: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", stages: STAGES }]);
    }
    if (url.includes("/api/deals")) return ok(DEALS);
    return ok({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CRM pipeline board", () => {
  it("shows won deals in the Enrolled column and lost deals in their own list", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PipelineTab />
      </QueryClientProvider>,
    );

    // Won deals render as "Won" cards (both of them, even the one whose
    // stage is still New Lead), not as open cards with Won/Lost buttons.
    expect(await screen.findByText("Wanda Test")).toBeInTheDocument();
    expect(screen.getByText("Walter Test")).toBeInTheDocument();
    expect(screen.getAllByText(/^Won · /)).toHaveLength(2);

    // The open deal gets one action menu, not per-card Won/Lost buttons.
    expect(screen.getByRole("button", { name: "Actions for Olive Test" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Won$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Lost$/ })).not.toBeInTheDocument();

    // Lost deal is listed with its reason, and not on the board.
    const lostSection = screen.getByText("Lost deals (1)").closest("section") as HTMLElement;
    expect(within(lostSection).getByText("Lou Test")).toBeInTheDocument();
    expect(within(lostSection).getByText("Kept current plan")).toBeInTheDocument();

    // KPI numbers come from the analytics endpoint.
    expect(screen.getByText("Won deals")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});
