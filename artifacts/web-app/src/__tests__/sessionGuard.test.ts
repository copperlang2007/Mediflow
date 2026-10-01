/**
 * The browser-side rules that make "type the URL" land on sign-in after the
 * user has been idle or has left the app.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  LAST_ACTIVITY_KEY,
  LAST_SEEN_KEY,
  REOPEN_GRACE_MS,
  markActivity,
  markSeen,
  staleReason,
  clearSessionMarkers,
  saveIdleMinutes,
  storedIdleMinutes,
} from "@/lib/auth/sessionGuard";

const MIN = 60 * 1000;

function fakeStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

describe("staleReason", () => {
  beforeEach(() => void fakeStorage());

  it("asks for sign-in when there is no record (e.g. the cookie pre-dates this fix)", () => {
    expect(staleReason(30)).toBe("reopened");
  });

  it("keeps a recently active session", () => {
    markActivity(1_000_000);
    markSeen(1_000_000 + 5 * MIN); // an open tab keeps reporting in
    expect(staleReason(30, 1_000_000 + 5 * MIN)).toBeNull();
  });

  it("signs out once idle longer than the limit, even with a tab left open", () => {
    markActivity(0);
    markSeen(31 * MIN); // tab still open and alive, but nobody touched it
    expect(staleReason(30, 31 * MIN + 1000)).toBe("idle");
  });

  it("does not sign out just before the limit", () => {
    markActivity(0);
    markSeen(29 * MIN);
    expect(staleReason(30, 29 * MIN + 1000)).toBeNull();
  });

  it("treats a visit after every tab was closed as a new visit", () => {
    markActivity(0);
    expect(staleReason(30, REOPEN_GRACE_MS + 1000)).toBe("reopened");
  });

  it("respects a shorter agency setting", () => {
    markActivity(0);
    markSeen(16 * MIN);
    expect(staleReason(15, 16 * MIN + 1000)).toBe("idle");
  });

  it("clearing markers forces a fresh sign-in next time", () => {
    markActivity(1_000_000);
    clearSessionMarkers();
    expect(staleReason(30, 1_000_000)).toBe("reopened");
  });

  it("uses the shared storage keys (so all tabs agree)", () => {
    const m = fakeStorage();
    markActivity(42);
    expect(m.get(LAST_ACTIVITY_KEY)).toBe("42");
    expect(m.get(LAST_SEEN_KEY)).toBe("42");
  });

  it("stands down (no sign-out loop) when the browser blocks storage", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    (globalThis as any).localStorage = { getItem: blocked, setItem: blocked, removeItem: blocked };
    expect(staleReason(30, 10 * 60 * MIN)).toBeNull();
  });

  it("remembers the agency's idle limit for the next page load", () => {
    expect(storedIdleMinutes()).toBeNull();
    saveIdleMinutes(15);
    expect(storedIdleMinutes()).toBe(15);
    clearSessionMarkers();
    expect(storedIdleMinutes()).toBeNull();
  });
});
