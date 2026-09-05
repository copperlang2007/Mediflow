// @vitest-environment jsdom
/**
 * Component tests for the Team & seats page.
 *
 * The page exists to make one idea visible: a seat is a login, and a pending
 * invitation holds one. Everything worth pinning follows from that — the
 * counts an admin reads before inviting, the fact that unaccepted invitations
 * sit in the same ledger as members, and the two places the UI must refuse to
 * act because the plan is full.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";

import TeamPage from "@/pages/team";

interface SeatUsage {
  limit: number;
  activeUsers: number;
  pendingInvitations: number;
  used: number;
  available: number;
}

function seats(over: Partial<SeatUsage> = {}): SeatUsage {
  const base = {
    limit: 5,
    activeUsers: 2,
    pendingInvitations: 1,
    used: 3,
    available: 2,
  };
  return { ...base, ...over };
}

const MEMBERS = [
  {
    id: "u-admin",
    email: "ada@alpha.test",
    fullName: "Ada Admin",
    role: "agency_admin",
    isActive: true,
    lastLoginAt: null,
  },
  {
    id: "u-gone",
    email: "gus@alpha.test",
    fullName: "Gus Gone",
    role: "agent",
    isActive: false,
    lastLoginAt: null,
  },
];

const PENDING = [
  {
    id: "inv-2",
    email: "second.hire@alpha.test",
    role: "agent",
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    acceptedAt: null,
    revokedAt: null,
    invitedByUserId: "u-admin",
    createdAt: new Date().toISOString(),
  },
  {
    id: "inv-1",
    email: "new.hire@alpha.test",
    role: "compliance_manager",
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    acceptedAt: null,
    revokedAt: null,
    invitedByUserId: "u-admin",
    createdAt: new Date().toISOString(),
  },
];

/** Routes fetches by URL so each test only declares what it cares about. */
function mockApi(opts: {
  seats?: SeatUsage;
  invitations?: typeof PENDING;
  onPost?: (url: string, init?: RequestInit) => unknown;
  onDelete?: (url: string) => unknown;
  onPatch?: (url: string, init?: RequestInit) => unknown;
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    const ok = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as Response;

    if (method === "GET" && url.includes("/api/invitations")) {
      return ok({
        data: opts.invitations ?? PENDING,
        seats: opts.seats ?? seats(),
      });
    }
    if (method === "GET" && url.includes("/api/users")) {
      return ok({ data: MEMBERS, total: MEMBERS.length });
    }
    if (method === "POST") return ok(opts.onPost?.(url, init) ?? {});
    if (method === "DELETE") return ok(opts.onDelete?.(url) ?? {});
    if (method === "PATCH") return ok(opts.onPatch?.(url, init) ?? {});
    return ok({});
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { hook } = memoryLocation({ path: "/settings/team" });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Router hook={hook}>
          <TeamPage />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof mockApi>;

beforeEach(() => {
  fetchMock = mockApi({});
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("seat visibility", () => {
  it("states that pending invitations are holding seats", async () => {
    renderPage();

    expect(await screen.findByText("3")).toBeInTheDocument(); // used
    expect(screen.getByText(/2 available/)).toBeInTheDocument();
    // The whole point of the page: an unaccepted invitation already costs.
    expect(
      screen.getByText(/1 pending invitation/),
    ).toBeInTheDocument();
    expect(screen.getByText(/holding a seat/)).toBeInTheDocument();
  });

  it("shows members and unaccepted invitations in one ledger", async () => {
    renderPage();

    expect(await screen.findByText("Ada Admin")).toBeInTheDocument();
    expect(screen.getByText("new.hire@alpha.test")).toBeInTheDocument();
    expect(screen.getAllByText("Invited, not yet accepted")).toHaveLength(
      PENDING.length,
    );
  });
});

describe("a full plan refuses to spend a seat it does not have", () => {
  beforeEach(() => {
    fetchMock = mockApi({
      seats: seats({ limit: 3, activeUsers: 2, pendingInvitations: 1, used: 3, available: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("disables Invite member", async () => {
    renderPage();
    const button = await screen.findByRole("button", { name: /invite member/i });
    expect(button).toBeDisabled();
  });

  it("disables Reactivate for a deactivated member", async () => {
    renderPage();
    const button = await screen.findByRole("button", { name: /reactivate/i });
    expect(button).toBeDisabled();
  });

  it("explains how to free a seat rather than just refusing", async () => {
    renderPage();
    expect(
      await screen.findByText(/Revoke a pending invitation, deactivate a member/i),
    ).toBeInTheDocument();
  });
});

describe("revoking", () => {
  it("confirms before revoking, and says the seat comes back", async () => {
    const onDelete = vi.fn(() => ({}));
    fetchMock = mockApi({ onDelete });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    // Two pending invitations are seeded; revoke the one for new.hire.
    const revokeButtons = await screen.findAllByRole("button", {
      name: /^revoke$/i,
    });
    fireEvent.click(revokeButtons[1]!);

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/the seat it holds returns to your plan/i),
    ).toBeInTheDocument();
    // The address is named, so an admin cannot revoke the wrong one blind.
    expect(within(dialog).getByText(/new\.hire@alpha\.test/)).toBeInTheDocument();

    // Nothing has been sent until the confirmation is taken.
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith(
        expect.stringContaining("/api/invitations/inv-1"),
      );
    });
  });
});

describe("the displayed link belongs to one invitation", () => {
  it("does not drop invitation A's live link when invitation B is resent", async () => {
    // Reachable when RESEND_API_KEY is set (and the API restarted) while an
    // admin's tab stays open: earlier invitations were created without email,
    // later ones send. A's token is untouched by B's resend — the server
    // rotates only `WHERE id = :id` — so dropping A's link takes away a
    // working link with no indication it still works.
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const ok = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as Response;

      if (method === "GET" && url.includes("/api/invitations")) {
        return ok({ data: PENDING, seats: seats() });
      }
      if (method === "GET" && url.includes("/api/users")) {
        return ok({ data: MEMBERS, total: MEMBERS.length });
      }
      if (method === "POST" && url.includes("/inv-1/resend")) {
        return ok({ acceptUrl: "https://app.test/accept-invite?token=AAA", emailSent: false });
      }
      if (method === "POST" && url.includes("/inv-2/resend")) {
        return ok({ acceptUrl: "https://app.test/accept-invite?token=BBB", emailSent: true });
      }
      return ok({});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const resendButtons = await screen.findAllByRole("button", { name: /resend/i });
    // inv-1 first (no email) — its link is surfaced for copying.
    fireEvent.click(resendButtons[1]!);
    expect(
      await screen.findByText("https://app.test/accept-invite?token=AAA"),
    ).toBeInTheDocument();

    // inv-2 next, which does send by email. A's link must survive.
    fireEvent.click(resendButtons[0]!);
    await waitFor(() =>
      expect(
        screen.queryByText("https://app.test/accept-invite?token=BBB"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("https://app.test/accept-invite?token=AAA"),
    ).toBeInTheDocument();
  });

  it("does clear the link when the invitation that owns it is resent by email", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const ok = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as Response;

      if (method === "GET" && url.includes("/api/invitations")) {
        return ok({ data: PENDING, seats: seats() });
      }
      if (method === "GET" && url.includes("/api/users")) {
        return ok({ data: MEMBERS, total: MEMBERS.length });
      }
      if (method === "POST" && url.includes("/inv-1/resend")) {
        // Same invitation twice: first without email, then with. The first
        // link is dead the moment the second resend rotates the token.
        const nth = fetchMock.mock.calls.filter(([u, i]) =>
          String(u).includes("/inv-1/resend") &&
          (i as RequestInit | undefined)?.method === "POST").length;
        return nth <= 1
          ? ok({ acceptUrl: "https://app.test/accept-invite?token=AAA", emailSent: false })
          : ok({ acceptUrl: "https://app.test/accept-invite?token=CCC", emailSent: true });
      }
      return ok({});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const resendButtons = await screen.findAllByRole("button", { name: /resend/i });
    fireEvent.click(resendButtons[1]!);
    expect(
      await screen.findByText("https://app.test/accept-invite?token=AAA"),
    ).toBeInTheDocument();

    fireEvent.click(resendButtons[1]!);
    await waitFor(() =>
      expect(
        screen.queryByText("https://app.test/accept-invite?token=AAA"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("deactivating", () => {
  it("warns that history is kept before freeing the seat", async () => {
    const onPatch = vi.fn(() => ({}));
    fetchMock = mockApi({ onPatch });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /deactivate/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Ada Admin/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/assigned contacts, and history are kept/i),
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /^deactivate$/i }),
    );

    await waitFor(() => {
      const [url, init] = onPatch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/users/u-admin/active");
      expect(JSON.parse(String(init.body))).toEqual({ isActive: false });
    });
  });
});

describe("inviting", () => {
  it("will not submit an address that is not an address", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /invite member/i }));
    const dialog = await screen.findByRole("dialog");

    const send = within(dialog).getByRole("button", { name: /send invitation/i });
    expect(send).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/email address/i), {
      target: { value: "not-an-email" },
    });
    expect(send).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/email address/i), {
      target: { value: "real@alpha.test" },
    });
    expect(send).toBeEnabled();
  });

  it("surfaces the link when the deployment cannot send email", async () => {
    fetchMock = mockApi({
      onPost: () => ({
        invitation: { ...PENDING[0], email: "real@alpha.test" },
        acceptUrl: "https://app.test/accept-invite?token=abc123",
        emailSent: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /invite member/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/email address/i), {
      target: { value: "real@alpha.test" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /send invitation/i }));

    // An invitation nobody can act on is not a success — the link is the only
    // way in, so it has to be on screen.
    expect(
      await screen.findByText("https://app.test/accept-invite?token=abc123"),
    ).toBeInTheDocument();
  });

  it("does not show a link when the email was delivered", async () => {
    fetchMock = mockApi({
      onPost: () => ({
        invitation: { ...PENDING[0], email: "real@alpha.test" },
        acceptUrl: "https://app.test/accept-invite?token=secret",
        emailSent: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /invite member/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/email address/i), {
      target: { value: "real@alpha.test" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /send invitation/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // The token is a credential: it must not linger on screen when it was
    // delivered by the channel it was meant for.
    expect(screen.queryByText(/token=secret/)).not.toBeInTheDocument();
  });
});
