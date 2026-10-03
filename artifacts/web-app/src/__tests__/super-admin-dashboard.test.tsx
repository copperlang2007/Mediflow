// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: "u1", role: "super_admin", orgId: "a1" } }),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({
    agencies: [
      { id: "a1", name: "Cascade Senior Advisors", slug: "cascade", planTier: "pro", createdAt: "2026-01-01", users: 3, agents: 2, clients: 40, pendingInvitations: 0 },
      { id: "a2", name: "Pending Agency", slug: "pending", planTier: "free", createdAt: "2026-02-01", users: 0, agents: 0, clients: 0, pendingInvitations: 1 },
    ],
  }),
}));

import SuperAdminDashboard from "@/pages/super-admin-dashboard";
import { PLATFORM_NAV_GROUPS, effectiveViewAsOrg, isPlatformPath, isPlatformView, visibleNavGroups } from "@/components/layout/nav-config";

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
    for (const ok of ["/dashboard", "/admin/workspaces", "/admin/health", "/settings/security", "/settings/security/mfa", "/dev/db"]) {
      expect(isPlatformPath(ok)).toBe(true);
    }
    for (const no of ["/crm", "/crm/contacts/1", "/commissions", "/settings", "/settings/team", "/admin/queue", "/agents"]) {
      expect(isPlatformPath(no)).toBe(false);
    }
  });

  it("ignores a stored view-as id that is the user's own agency", () => {
    expect(effectiveViewAsOrg("o-home", "o-home")).toBeNull();
    expect(effectiveViewAsOrg("o-other", "o-home")).toBe("o-other");
    expect(effectiveViewAsOrg(null, "o-home")).toBeNull();
  });
});
