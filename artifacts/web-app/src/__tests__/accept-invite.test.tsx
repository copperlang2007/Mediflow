// @vitest-environment jsdom
/**
 * Component tests for the public accept-invitation screen.
 *
 * This is the only page reachable by someone who belongs to no agency, and the
 * first thing about the product they ever see. Two properties matter most:
 * they learn who invited them and to what BEFORE being asked to create an
 * account, and a link that cannot work says why in language a person can act
 * on rather than failing generically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const clerkState = {
  isLoaded: true,
  isSignedIn: false as boolean,
  user: null as { fullName?: string; primaryEmailAddress?: { emailAddress: string } } | null,
};

const getTokenMock = vi.hoisted(() =>
  vi.fn(async (_opts?: { skipCache?: boolean }) => "clerk-token"),
);

vi.mock("@clerk/react", () => ({
  useUser: () => clerkState,
  useAuth: () => ({ getToken: getTokenMock }),
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import AcceptInvitePage from "@/pages/accept-invite";
import { readPendingInvite } from "@/lib/pendingInvite";

const PREVIEW = {
  email: "new.hire@alpha.test",
  role: "compliance_manager",
  roleLabel: "Compliance Manager",
  organizationName: "Alpha Agency",
  expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
};

function mockLookup(
  result: { ok: true } | { ok: false; status: number; code: string },
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/invitations/lookup")) {
      if (result.ok) {
        return { ok: true, status: 200, json: async () => PREVIEW } as Response;
      }
      return {
        ok: false,
        status: result.status,
        json: async () => ({ error: "nope", code: result.code }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <AcceptInvitePage />
      </Router>
    </QueryClientProvider>,
  );
}

const LONG_TOKEN = "test-invite-token-0123456789";

beforeEach(() => {
  window.localStorage.clear();
  getTokenMock.mockClear();
  clerkState.isSignedIn = false;
  clerkState.user = null;
  // wouter's memoryLocation does not touch window.location, which the page
  // reads to build its post-sign-in redirect.
  window.history.replaceState({}, "", "/accept-invite?token=abc123");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("before signing in", () => {
  it("names the agency and the role first", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt("/accept-invite?token=abc123");

    expect(await screen.findByText(/Join Alpha Agency/)).toBeInTheDocument();
    expect(screen.getByText("Compliance Manager")).toBeInTheDocument();
    // Shown twice on purpose: once as the invitation's own detail, once in the
    // guidance to sign up with that address if they can.
    expect(screen.getAllByText("new.hire@alpha.test").length).toBeGreaterThan(0);

    // Only then is an account asked for.
    expect(
      screen.getByRole("link", { name: /create an account/i }),
    ).toBeInTheDocument();
  });

  it("carries the invitation through sign-in so the link is not lost", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt("/accept-invite?token=abc123");

    const link = await screen.findByRole("link", {
      name: /i already have an account/i,
    });
    // Without the redirect the invitee signs in and lands nowhere near the
    // invitation they were trying to accept.
    expect(link.getAttribute("href")).toContain("redirect_url=");
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain(
      "token=abc123",
    );
  });

  it("does not offer to accept before there is an identity to accept as", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt("/accept-invite?token=abc123");

    await screen.findByText(/Join Alpha Agency/);
    expect(
      screen.queryByRole("button", { name: /accept invitation/i }),
    ).not.toBeInTheDocument();
  });
});

describe("when signed in", () => {
  beforeEach(() => {
    clerkState.isSignedIn = true;
    clerkState.user = {
      fullName: "Nora Newhire",
      primaryEmailAddress: { emailAddress: "nora@personal.test" },
    };
  });

  it("offers to accept, prefilled with the signed-in name", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt("/accept-invite?token=abc123");

    const name = (await screen.findByLabelText(/your name/i)) as HTMLInputElement;
    expect(name.value).toBe("Nora Newhire");
    expect(
      screen.getByRole("button", { name: /accept invitation/i }),
    ).toBeEnabled();
  });

  it("posts the name that is actually on screen", async () => {
    const fetchMock = mockLookup({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/accept-invite?token=abc123");

    // The invitee accepts without touching the prefilled name — the common
    // path, and the one where a stale closure would send an empty string.
    fireEvent.click(
      await screen.findByRole("button", { name: /accept invitation/i }),
    );

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.fullName).toBe("Nora Newhire");
      expect(body.token).toBe("abc123");
    });
  });

  it("shows which account is being used, since it may not be the invited one", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt("/accept-invite?token=abc123");

    expect(
      await screen.findByText(/Signed in as nora@personal\.test/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /use a different account/i }),
    ).toBeInTheDocument();
  });
});

describe("links that cannot work", () => {
  it("explains an expired invitation and what to do about it", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: false, status: 410, code: "expired" }));
    renderAt("/accept-invite?token=abc123");

    expect(
      await screen.findByText(/Ask whoever invited you to send a new one/i),
    ).toBeInTheDocument();
  });

  it("distinguishes an already-used invitation from a broken one", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: false, status: 410, code: "accepted" }));
    renderAt("/accept-invite?token=abc123");

    expect(
      await screen.findByText(/already been used/i),
    ).toBeInTheDocument();
  });

  it("suggests a truncated copy-paste when the token is not found", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: false, status: 404, code: "invalid" }));
    renderAt("/accept-invite?token=abc123");

    expect(
      await screen.findByText(/Check that you copied all of it/i),
    ).toBeInTheDocument();
  });

  it("handles a link with no token at all without calling the API", async () => {
    const fetchMock = mockLookup({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/accept-invite");
    renderAt("/accept-invite");

    expect(
      await screen.findByText(/Invitation link missing/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});

describe("keeping the invitation through sign-up", () => {
  it("remembers the link so the app can bring the person back after sign-up", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);

    await screen.findByText(/Join Alpha Agency/);
    expect(readPendingInvite()).toBe(LONG_TOKEN);
  });

  it("keeps the link when the check fails for a reason that is not the link's fault", async () => {
    for (const status of [429, 503]) {
      window.localStorage.clear();
      vi.stubGlobal("fetch", mockLookup({ ok: false, status, code: "" }));
      const { unmount } = renderAt(`/accept-invite?token=${LONG_TOKEN}`);
      expect(await screen.findByText(/try again in a moment/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      expect(readPendingInvite()).toBe(LONG_TOKEN);
      unmount();
    }
  });

  it("keeps the link when the network drops", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);
    expect(await screen.findByText(/try again in a moment/i)).toBeInTheDocument();
    expect(readPendingInvite()).toBe(LONG_TOKEN);
  });

  it("lets a signed-in person drop the remembered invitation", async () => {
    clerkState.isSignedIn = true;
    clerkState.user = { fullName: "Nora", primaryEmailAddress: { emailAddress: "n@x.test" } };
    vi.stubGlobal("fetch", mockLookup({ ok: true }));
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);
    const forget = await screen.findByRole("button", { name: /forget this invitation/i });
    // jsdom cannot navigate; only the clearing matters here.
    const loc = window.location;
    vi.stubGlobal("location", { ...loc, href: loc.href });
    fireEvent.click(forget);
    expect(readPendingInvite()).toBeNull();
  });

  it("retries once with a fresh sign-in token when the first attempt is refused as unauthorized", async () => {
    clerkState.isSignedIn = true;
    clerkState.user = { fullName: "Nora", primaryEmailAddress: { emailAddress: "n@x.test" } };
    const base = mockLookup({ ok: true });
    let posts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return posts === 1
          ? ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) } as Response)
          : ({ ok: true, status: 201, json: async () => ({}) } as Response);
      }
      return base(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    getTokenMock
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }));
    await waitFor(() => expect(posts).toBe(2), { timeout: 4000 });

    // The retry must ask Clerk for a brand-new token and actually send it.
    expect(getTokenMock).toHaveBeenNthCalledWith(2, { skipCache: true });
    const sent = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(sent[0].Authorization).toBe("Bearer stale-token");
    expect(sent[1].Authorization).toBe("Bearer fresh-token");
  });

  it("explains a persistent 401 in plain words instead of just 'Unauthorized'", async () => {
    clerkState.isSignedIn = true;
    clerkState.user = { fullName: "Nora", primaryEmailAddress: { emailAddress: "n@x.test" } };
    const base = mockLookup({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) } as Response)
        : base(input)));
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }));
    await waitFor(
      () => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/sign out, sign back in/i)),
      { timeout: 4000 },
    );
    // A refused sign-in says nothing about the link, so it is kept.
    expect(readPendingInvite()).toBe(LONG_TOKEN);
  });

  it("stops remembering the link when accepting it fails for good", async () => {
    clerkState.isSignedIn = true;
    clerkState.user = { fullName: "Nora", primaryEmailAddress: { emailAddress: "n@x.test" } };
    const base = mockLookup({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: false, status: 409, json: async () => ({ error: "already", code: "already_provisioned" }) } as Response;
      }
      return base(input);
    }));
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }));
    await waitFor(() => expect(readPendingInvite()).toBeNull());
  });

  it("forgets a link that can never work, so it stops pulling the person back", async () => {
    vi.stubGlobal("fetch", mockLookup({ ok: false, status: 410, code: "revoked" }));
    renderAt(`/accept-invite?token=${LONG_TOKEN}`);

    expect(await screen.findByText(/withdrawn by the agency/i)).toBeInTheDocument();
    await waitFor(() => expect(readPendingInvite()).toBeNull());
  });
});
