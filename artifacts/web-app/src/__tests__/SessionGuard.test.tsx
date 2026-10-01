// @vitest-environment jsdom
/**
 * Component tests for SessionGuard: what the user sees and when the app
 * signs them out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const signOut = vi.fn();
let signedIn = true;
let sessionPending = false;
let sessionCreatedAt = 0;
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: signedIn }),
  useClerk: () => ({ signOut }),
  useSession: () => ({ session: signedIn && !sessionPending ? { createdAt: new Date(sessionCreatedAt) } : null }),
}));

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));

import { SessionGuard } from "@/components/auth/SessionGuard";
import {
  SESSION_EXPIRED_EVENT,
  LAST_ACTIVITY_KEY,
  LAST_SEEN_KEY,
  markActivity,
  setCallInProgress,
} from "@/lib/auth/sessionGuard";

function renderGuard() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SessionGuard>
        <div>dashboard</div>
      </SessionGuard>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  signOut.mockReset().mockResolvedValue(undefined);
  signedIn = true;
  sessionPending = false;
  sessionCreatedAt = 0;
});
afterEach(() => {
  setCallInProgress(false);
  vi.useRealTimers();
});

describe("SessionGuard", () => {
  it("shows the app when the visit is recent", async () => {
    markActivity();
    renderGuard();
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out and shows nothing when an old sign-in cookie is found", async () => {
    // no markers = nobody has been here recently
    let release!: () => void;
    signOut.mockImplementation(() => new Promise<void>((r) => (release = r)));
    renderGuard();
    expect(screen.queryByText("dashboard")).toBeNull();
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("dashboard")).toBeNull(); // still blocked until Clerk confirms
    await act(async () => release());
  });

  it("keeps the app hidden and retries when sign-out fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signOut.mockRejectedValueOnce(new Error("clerk down")).mockResolvedValue(undefined);
    renderGuard();
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("dashboard")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
  });

  it("signs out when the API says the session expired", async () => {
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("hides the app while a runtime sign-out is failing, then recovers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    signOut.mockRejectedValueOnce(new Error("clerk down")).mockResolvedValue(undefined);
    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });
    await waitFor(() => expect(screen.queryByText("dashboard")).toBeNull());
    // a message, not a blank page, while Clerk is slow
    expect(screen.getByRole("status").textContent).toMatch(/signing you out/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
  });

  it("signs out when the tab comes back after being idle too long", async () => {
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    const old = String(Date.now() - 31 * 60 * 1000);
    localStorage.setItem(LAST_ACTIVITY_KEY, old);
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("does not sign out during a live phone call", async () => {
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    setCallInProgress(true);
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 31 * 60 * 1000));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(signOut).not.toHaveBeenCalled();
  });

  it("waits for the session object after a redirect sign-in instead of signing out", async () => {
    sessionPending = true;
    renderGuard();
    await new Promise((r) => setTimeout(r, 50));
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.queryByText("dashboard")).toBeNull();
  });

  it("treats a session created 10 seconds ago as a fresh login (no markers yet)", async () => {
    sessionCreatedAt = Date.now() - 10_000;
    renderGuard();
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out an old session found with no markers", async () => {
    sessionCreatedAt = Date.now() - 10 * 60_000;
    renderGuard();
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("allows a few seconds of clock lag on a fresh login", async () => {
    sessionCreatedAt = Date.now() + 3_000;
    renderGuard();
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does not trust a session 'created' far in the future (clock skew)", async () => {
    sessionCreatedAt = Date.now() + 60_000;
    renderGuard();
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("keeps the server session alive with a heartbeat during a live call", async () => {
    const { apiFetch } = await import("@/lib/api");
    (apiFetch as any).mockClear();
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    setCallInProgress(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/users/me"));
  });

  function focusFrame(tag: string) {
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => ({ tagName: tag }) });
  }
  function releaseFocus() {
    delete (document as any).activeElement;
  }

  it("counts working in the signing page's document frame as activity", async () => {
    window.history.pushState({}, "", "/sign/env-123");
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 31 * 60 * 1000));
    focusFrame("IFRAME");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(signOut).not.toHaveBeenCalled();
    releaseFocus();
    window.history.pushState({}, "", "/");
  });

  it("does not exempt other pages just because a frame has focus", async () => {
    window.history.pushState({}, "", "/dashboard");
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 31 * 60 * 1000));
    focusFrame("IFRAME");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    releaseFocus();
    window.history.pushState({}, "", "/");
  });

  it("does not exempt look-alike paths such as /documents/sign/x", async () => {
    window.history.pushState({}, "", "/documents/sign/x");
    markActivity();
    renderGuard();
    await screen.findByText("dashboard");
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 31 * 60 * 1000));
    focusFrame("IFRAME");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    releaseFocus();
    window.history.pushState({}, "", "/");
  });

  it("returns to the page the user was on after a forced sign-out (invite links)", async () => {
    window.history.pushState({}, "", "/accept-invite?token=abc123");
    renderGuard(); // no markers: old cookie
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    const arg = signOut.mock.calls[0][0] as { redirectUrl: string };
    expect(arg.redirectUrl).toContain("/sign-in?redirect_url=");
    expect(decodeURIComponent(arg.redirectUrl)).toContain("/accept-invite?token=abc123");
    window.history.pushState({}, "", "/");
  });

  it("does not treat Clerk session re-emissions as user activity", async () => {
    markActivity();
    const view = renderGuard();
    await screen.findByText("dashboard");
    const old = String(Date.now() - 10 * 60 * 1000);
    localStorage.setItem(LAST_ACTIVITY_KEY, old);
    // Clerk hands back a new session object on each token refresh.
    const qc = new QueryClient();
    view.rerender(
      <QueryClientProvider client={qc}>
        <SessionGuard>
          <div>dashboard</div>
        </SessionGuard>
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(localStorage.getItem(LAST_ACTIVITY_KEY)).toBe(old);
  });

  it("blocks the keypress that discovers an expired session from reaching the page", async () => {
    const onKey = vi.fn();
    markActivity();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionGuard>
          <input aria-label="note" onKeyDown={onKey} />
        </SessionGuard>
      </QueryClientProvider>,
    );
    const input = await screen.findByLabelText("note");
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 31 * 60 * 1000));
    fireEvent.keyDown(input, { key: "x" });
    expect(onKey).not.toHaveBeenCalled();
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("lets keypresses through while the session is current", async () => {
    const onKey = vi.fn();
    markActivity();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionGuard>
          <input aria-label="note" onKeyDown={onKey} />
        </SessionGuard>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(await screen.findByLabelText("note"), { key: "x" });
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does nothing for signed-out visitors (public pages)", async () => {
    signedIn = false;
    renderGuard();
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });
});
