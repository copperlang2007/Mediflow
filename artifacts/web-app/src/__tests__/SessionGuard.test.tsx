// @vitest-environment jsdom
/**
 * Component tests for SessionGuard: what the user sees and when the app
 * signs them out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const signOut = vi.fn();
let signedIn = true;
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: signedIn }),
  useClerk: () => ({ signOut, session: null }),
}));

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

  it("does nothing for signed-out visitors (public pages)", async () => {
    signedIn = false;
    renderGuard();
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });
});
