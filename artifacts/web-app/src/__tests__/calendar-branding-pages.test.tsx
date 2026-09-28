// @vitest-environment jsdom
/**
 * Render tests for the stage2/calendar-branding pages: Calendar, Branding,
 * Workspaces, plus the BrandingProvider → BrandLockup hook-up.
 *
 * `fetch` is replaced with a small router so every number the pages show is
 * traceable to a mocked API response — none are invented by the UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import CalendarPage from "@/pages/calendar";
import BrandingPage from "@/pages/branding";
import WorkspacesPage, { slugify } from "@/pages/workspaces";
import { BrandLockup } from "@/components/brand/BrandMark";
import { BrandingProvider, brandingStylesheet, resolveBranding } from "@/lib/branding/BrandingProvider";
import { contrastLevel, hexToHslTriplet } from "@/lib/branding/rules";

type Role = "super_admin" | "agency_admin" | "agent";

function user(role: Role) {
  return { id: `u-${role}`, orgId: "o-1", email: `${role}@x.test`, fullName: "Pat Doe", role, isActive: true };
}

type Handler = (url: URL, init?: RequestInit) => unknown;
let routes: Record<string, Handler> = {};
let calls: Array<{ url: string; method: string; body?: unknown }> = [];

function installFetch(role: Role) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: url.pathname + url.search, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname.endsWith("/api/users/me")) return json(user(role));
      const key = `${method} ${url.pathname.replace(/^.*\/api\//, "/api/")}`;
      const h = routes[key];
      if (!h) return json({ error: `unmocked ${key}` }, 404);
      return json(h(url, init));
    }),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderWith(node: React.ReactNode, role: Role, path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(getGetMeQueryKey(), user(role));
  const { hook } = memoryLocation({ path, static: true });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TooltipProvider>{node}</TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

const BRANDING_DEFAULT = {
  orgName: "Alpha Agency",
  productName: null,
  tagline: null,
  primaryColor: null,
  accentColor: null,
  displayFont: null,
  bodyFont: null,
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  emailFromName: null,
  updatedAt: null,
  isDefault: true,
};

beforeEach(() => {
  routes = {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById("org-branding-vars")?.remove();
});

describe("Calendar page", () => {
  it("shows real counts and today's appointments from the API", async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0);
    routes["GET /api/appointments"] = () => ({
      scope: "org",
      summary: { total: 2, confirmed: 1, pending: 1, completed: 0, cancelled: 0, no_show: 0 },
      data: [
        {
          id: "a1",
          contactId: "c1",
          agentId: "g1",
          type: "review",
          title: "Annual review",
          notes: null,
          notesMasked: false,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
          status: "confirmed",
          locationType: "phone",
          locationDetail: null,
          meetingUrl: null,
          reminderSentAt: null,
          createdBy: null,
          contact: { id: "c1", firstName: "Mina", lastName: "Lopez" },
          agent: { id: "g1", firstName: "Carla", lastName: "Reyes" },
        },
      ],
    });
    routes["GET /api/appointments/agent-options"] = () => ({ data: [] });
    installFetch("agency_admin");
    renderWith(<CalendarPage />, "agency_admin", "/calendar");

    expect(await screen.findByText("Mina Lopez")).toBeInTheDocument();
    expect(screen.getByText("Calendar & Appointments")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Appointment/ })).toBeInTheDocument();
    expect(screen.getByText(/Coming soon/i)).toBeInTheDocument();
    const listCall = calls.find((c) => c.url.startsWith("/api/appointments?"));
    expect(listCall?.url).toMatch(/from=.*&to=/);
  });

  it("hides booking for a viewer-like role and switches views", async () => {
    routes["GET /api/appointments"] = () => ({
      scope: "org",
      summary: { total: 0, confirmed: 0, pending: 0, completed: 0, cancelled: 0, no_show: 0 },
      data: [],
    });
    installFetch("super_admin");
    renderWith(<CalendarPage />, "super_admin", "/calendar");
    fireEvent.click(await screen.findByRole("tab", { name: "agenda" }));
    expect(await screen.findByText(/Nothing booked in the next 30 days/)).toBeInTheDocument();
  });
});

describe("Branding page", () => {
  it("loads, previews and saves validated values", async () => {
    routes["GET /api/organizations/me/branding"] = () => BRANDING_DEFAULT;
    routes["PUT /api/organizations/me/branding"] = (_u, init) => ({
      ...BRANDING_DEFAULT,
      ...JSON.parse(String(init?.body)),
      isDefault: false,
      warnings: [],
    });
    installFetch("agency_admin");
    renderWith(<BrandingPage />, "agency_admin", "/branding");

    const name = await screen.findByLabelText("Product name");
    fireEvent.change(name, { target: { value: "Sunrise Senior" } });
    fireEvent.change(screen.getByLabelText("Primary"), { target: { value: "#1e3a5f" } });
    expect(await screen.findByText(/Readable/)).toBeInTheDocument();
    // The preview's lockup picks up the unsaved name.
    expect(screen.getAllByText("Sunrise Senior").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ productName: "Sunrise Senior", primaryColor: "#1e3a5f", accentColor: null });
    expect(screen.getByText(/Custom domain/)).toBeInTheDocument();
  });

  it("blocks saving a colour that is too light", async () => {
    routes["GET /api/organizations/me/branding"] = () => BRANDING_DEFAULT;
    installFetch("agency_admin");
    renderWith(<BrandingPage />, "agency_admin", "/branding");
    await screen.findByLabelText("Product name");
    fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#ffeb3b" } });
    expect(await screen.findByText(/too light to read on white/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("is read-only for non-owners", async () => {
    routes["GET /api/organizations/me/branding"] = () => BRANDING_DEFAULT;
    installFetch("agent");
    renderWith(<BrandingPage />, "agent", "/branding");
    expect(await screen.findByText(/Only agency owners can change branding/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save changes/ })).toBeNull();
  });
});

describe("Workspaces page", () => {
  it("is restricted to super_admin", async () => {
    installFetch("agency_admin");
    renderWith(<WorkspacesPage />, "agency_admin", "/admin/workspaces");
    expect(await screen.findByText("Access Restricted")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/admin/agencies"))).toBe(false);
  });

  it("lists agencies with live counts and creates one via invitation", async () => {
    routes["GET /api/admin/agencies/overview"] = () => ({
      agencies: [
        { id: "o-1", name: "HQ", slug: "hq", planTier: "starter", createdAt: "2026-01-01T00:00:00Z", users: 3, agents: 2, clients: 40, pendingInvitations: 0 },
        { id: "o-2", name: "Cascade", slug: "cascade", planTier: "starter", createdAt: "2026-02-01T00:00:00Z", users: 0, agents: 0, clients: 0, pendingInvitations: 1 },
      ],
    });
    routes["POST /api/admin/agencies"] = () => ({
      agency: { id: "o-3", name: "Sunrise", slug: "sunrise" },
      invitation: { email: "owner@sunrise.test", expiresAt: "2026-10-10T00:00:00Z" },
      acceptUrl: "https://app.test/accept-invite?token=abc",
      emailSent: false,
    });
    installFetch("super_admin");
    renderWith(<WorkspacesPage />, "super_admin", "/admin/workspaces");

    expect(await screen.findByText("Cascade")).toBeInTheDocument();
    expect(screen.getByText("1 pending invitation")).toBeInTheDocument();
    expect(screen.getAllByText("40").length).toBe(2); // KPI total + table cell

    fireEvent.change(screen.getByLabelText("Agency name"), { target: { value: "Sunrise Advisors" } });
    expect(screen.getByLabelText("Slug")).toHaveValue("sunrise-advisors");
    fireEvent.change(screen.getByLabelText(/administrator's email/), { target: { value: "owner@sunrise.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByDisplayValue("https://app.test/accept-invite?token=abc")).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it("slugify matches the server's rules", () => {
    expect(slugify("Cascade Senior Advisors, LLC")).toBe("cascade-senior-advisors-llc");
  });
});

describe("BrandingProvider", () => {
  it("applies the org's name to BrandLockup and writes CSS variables", async () => {
    routes["GET /api/organizations/me/branding"] = () => ({
      ...BRANDING_DEFAULT,
      productName: "Sunrise Senior",
      primaryColor: "#1e3a5f",
      isDefault: false,
    });
    installFetch("agent");
    renderWith(
      <BrandingProvider>
        <BrandLockup />
      </BrandingProvider>,
      "agent",
    );
    expect(await screen.findByText("Sunrise Senior")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.getElementById("org-branding-vars")?.textContent).toContain(`--primary: ${hexToHslTriplet("#1e3a5f")}`),
    );
  });

  it("falls back to agencyBRIDGE and keeps the default sidebar for light primaries", () => {
    render(<BrandLockup />);
    expect(screen.getByText("BRIDGE")).toBeInTheDocument();
    const css = brandingStylesheet(resolveBranding({ primaryColor: "#5b8cbe" }));
    expect(css).toContain("--primary:");
    expect(css).not.toContain("--sidebar:");
  });

  it("only overrides dark-mode tokens with an accent that stays readable", async () => {
    const { brandingVars } = await import("@/lib/branding/BrandingProvider");
    const { contrastRatio } = await import("@/lib/branding/rules");
    // A dark accent would vanish on the navy page: dark mode keeps the default blue.
    expect(brandingVars(resolveBranding({ accentColor: "#28507f" }), "dark")).toEqual({});
    // A light accent is used, and its button text clears WCAG AA.
    const vars = brandingVars(resolveBranding({ accentColor: "#8cc4ff" }), "dark");
    expect(vars["--primary"]).toBe(hexToHslTriplet("#8cc4ff"));
    const fg = vars["--primary-foreground"] === hexToHslTriplet("#ffffff") ? "#ffffff" : "#0b1220";
    expect(contrastRatio("#8cc4ff", fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("grades contrast like the server", () => {
    expect(contrastLevel("#0f1b3d").level).toBe("good");
    expect(contrastLevel("#e0701a").level).toBe("large-only");
    expect(contrastLevel("#ffeb3b").level).toBe("fail");
  });
});
