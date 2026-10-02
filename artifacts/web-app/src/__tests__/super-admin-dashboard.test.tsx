// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({
    agencies: [
      { id: "a1", name: "Cascade Senior Advisors", slug: "cascade", planTier: "pro", createdAt: "2026-01-01", users: 3, agents: 2, clients: 40, pendingInvitations: 0 },
      { id: "a2", name: "Pending Agency", slug: "pending", planTier: "free", createdAt: "2026-02-01", users: 0, agents: 0, clients: 0, pendingInvitations: 1 },
    ],
  }),
}));

import SuperAdminDashboard from "@/pages/super-admin-dashboard";
import { PLATFORM_NAV_GROUPS, visibleNavGroups } from "@/components/layout/nav-config";

describe("SuperAdminDashboard", () => {
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
    const hrefs = visibleNavGroups("super_admin", PLATFORM_NAV_GROUPS).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toEqual(["/dashboard", "/admin/workspaces", "/admin/health", "/settings/security"]);
  });
});
