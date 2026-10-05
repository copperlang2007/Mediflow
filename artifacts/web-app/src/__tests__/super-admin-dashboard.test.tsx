// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: "u1", role: "super_admin", orgId: "a1" } }),
}));

// jsdom has no ResizeObserver; the charts' responsive container needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const state = vi.hoisted(() => ({ metricsFail: false }));

const METRICS = {
  months: ["2026-09", "2026-10"],
  revenue: {
    basis: "list_price",
    mrrCents: 29_700,
    arrCents: 356_400,
    payingAgencies: 1,
    trialingAgencies: 1,
    pastDueAgencies: 1,
    atRiskCents: 99_700,
    byPlan: [{ tier: "growth", agencies: 1, mrrCents: 29_700 }],
  },
  commissions: { allTimeCents: 135_000, last12MonthsCents: 35_075 },
  growth: [
    {
      month: "2026-09",
      newAgencies: 1,
      totalAgencies: 1,
      newClients: 10,
      totalClients: 10,
      commissionsCents: 20_000,
    },
    {
      month: "2026-10",
      newAgencies: 1,
      totalAgencies: 2,
      newClients: 30,
      totalClients: 40,
      commissionsCents: 15_075,
    },
  ],
  agencies: [
    {
      orgId: "a1",
      subscriptionStatus: "active",
      planTier: "growth",
      mrrCents: 29_700,
      commissionsLast12MonthsCents: 30_050,
      commissionsAllTimeCents: 30_050,
    },
    {
      orgId: "a2",
      subscriptionStatus: "past_due",
      planTier: "agency",
      mrrCents: 0,
      commissionsLast12MonthsCents: 5_025,
      commissionsAllTimeCents: 5_025,
    },
  ],
};

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    if (url.includes("/platform/metrics")) {
      if (state.metricsFail)
        throw Object.assign(new Error("boom"), { status: 500 });
      return METRICS;
    }
    return {
      agencies: [
        {
          id: "a1",
          name: "Cascade Senior Advisors",
          slug: "cascade",
          planTier: "pro",
          createdAt: "2026-01-01",
          users: 3,
          agents: 2,
          clients: 40,
          pendingInvitations: 0,
        },
        {
          id: "a2",
          name: "Pending Agency",
          slug: "pending",
          planTier: "free",
          createdAt: "2026-02-01",
          users: 0,
          agents: 0,
          clients: 0,
          pendingInvitations: 1,
        },
      ],
    };
  },
}));

import SuperAdminDashboard from "@/pages/super-admin-dashboard";
import {
  PLATFORM_NAV_GROUPS,
  effectiveViewAsOrg,
  isPlatformPath,
  isPlatformView,
  visibleNavGroups,
} from "@/components/layout/nav-config";

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SuperAdminDashboard />
    </QueryClientProvider>,
  );
}

describe("SuperAdminDashboard", () => {
  beforeEach(() => {
    state.metricsFail = false;
  });

  it("shows platform totals and every agency", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SuperAdminDashboard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Cascade Senior Advisors")).toBeTruthy();
    expect(screen.getByText("Platform overview")).toBeTruthy();
    expect(screen.getByText("Needs a nudge")).toBeTruthy();
  });

  it("platform nav has no agency pages", () => {
    const hrefs = visibleNavGroups("super_admin", PLATFORM_NAV_GROUPS).flatMap(
      (g) => g.items.map((i) => i.href),
    );
    expect(hrefs).toEqual([
      "/dashboard",
      "/admin/workspaces",
      "/admin/health",
      "/settings/security",
    ]);
  });

  it("hides View for the super admin's own organization only", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SuperAdminDashboard />
      </QueryClientProvider>,
    );
    await screen.findByText("Cascade Senior Advisors");
    // a1 is own org (no View); a2 shows View in the table and in "Needs a nudge".
    expect(screen.getAllByRole("button", { name: /view/i })).toHaveLength(2);
  });

  it("chooses the platform view only for a super admin not viewing an agency", () => {
    expect(isPlatformView("super_admin", false)).toBe(true);
    expect(isPlatformView("super_admin", true)).toBe(false);
    expect(isPlatformView("agency_admin", false)).toBe(false);
    expect(isPlatformView(null, false)).toBe(false);
  });

  it("allows only platform pages in the platform view", () => {
    for (const ok of [
      "/dashboard",
      "/admin/workspaces",
      "/admin/health",
      "/settings/security",
      "/settings/security/mfa",
      "/dev/db",
    ]) {
      expect(isPlatformPath(ok)).toBe(true);
    }
    for (const no of [
      "/crm",
      "/crm/contacts/1",
      "/commissions",
      "/settings",
      "/settings/team",
      "/admin/queue",
      "/agents",
    ]) {
      expect(isPlatformPath(no)).toBe(false);
    }
  });

  it("ignores a stored view-as id that is the user's own agency", () => {
    expect(effectiveViewAsOrg("o-home", "o-home")).toBeNull();
    expect(effectiveViewAsOrg("o-other", "o-home")).toBe("o-other");
    expect(effectiveViewAsOrg(null, "o-home")).toBeNull();
  });

  it("shows revenue, run rate, revenue at risk and commissions, and per-agency money", async () => {
    renderPage();
    expect(await screen.findAllByText("$297")).toHaveLength(2); // monthly revenue + Cascade's row
    expect(screen.getByText("$3,564")).toBeTruthy(); // yearly run rate
    expect(screen.getByText("$997")).toBeTruthy(); // revenue at risk
    expect(screen.getByText("$351")).toBeTruthy(); // 12-month commissions ($350.75)
    expect(screen.getByText(/1 paying · 1 on trial/)).toBeTruthy();
    expect(
      screen.getByText(/estimated from active plans at list price/i),
    ).toBeTruthy();
    // A past-due agency's status is surfaced next to its plan.
    expect(screen.getByText("past due")).toBeTruthy();
  });

  it("offers the last 12 months as a table", async () => {
    renderPage();
    const summary = await screen.findByText(
      /view the last 12 months as a table/i,
    );
    const table = within(summary.closest("details")!).getByRole("table");
    expect(within(table).getByText("Oct 26")).toBeTruthy();
    expect(within(table).getByText("$150.75")).toBeTruthy();
  });

  it("shows dashes, not zeros, when the money figures fail to load", async () => {
    state.metricsFail = true;
    renderPage();
    expect(
      await screen.findByText(
        /revenue and commission figures are unavailable/i,
      ),
    ).toBeTruthy();
    // Agencies still list from the overview.
    expect(screen.getByText("Cascade Senior Advisors")).toBeTruthy();
    expect(screen.queryByText("$0")).toBeNull();
  });

  it("drops previously loaded money figures when a later refresh fails", async () => {
    renderPage();
    expect(await screen.findByText("$3,564")).toBeTruthy();
    state.metricsFail = true;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/revenue and commission figures are unavailable/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("$3,564")).toBeNull();
    expect(screen.queryByText("$351")).toBeNull();
  });
});
