/**
 * The browser-side rules that make "type the URL" land on sign-in after the
 * user has been idle or has left the app.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LAST_ACTIVITY_KEY,
  LAST_SEEN_KEY,
  REOPEN_GRACE_MS,
  markActivity,
  markSeen,
  staleReason,
  clearSessionMarkers,
  saveIdleMinutes,
  IDLE_MINUTES_KEY,
  signInUrlAfterSignOut,
  isCallInProgress,
  setCallInProgress,
  MAX_CALL_EXEMPTION_MS,
  isUsingEmbeddedDocument,
  storageAvailable,
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

  it("still enforces idle time from memory when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    (globalThis as any).localStorage = { getItem: blocked, setItem: blocked, removeItem: blocked };
    markActivity(0);
    expect(staleReason(30, 29 * MIN)).toBeNull();
    expect(staleReason(30, 31 * MIN)).toBe("idle");
    clearSessionMarkers();
  });

  it("treats activity timestamps from the future (clock moved back) as stale", () => {
    markActivity(10 * MIN);
    expect(staleReason(30, 1 * MIN)).toBe("reopened");
  });

  it("tolerates a routine clock correction of a few seconds", () => {
    markActivity(10 * MIN);
    markSeen(10 * MIN);
    expect(staleReason(30, 10 * MIN - 20 * 1000)).toBeNull();
  });

  it("builds the post-sign-out destination", () => {
    expect(signInUrlAfterSignOut("", { pathname: "/", search: "" })).toBe("/sign-in");
    expect(signInUrlAfterSignOut("", { pathname: "/sign-in/factor-one", search: "" })).toBe("/sign-in");
    // other query strings are never copied into the sign-in address
    expect(signInUrlAfterSignOut("", { pathname: "/dashboard", search: "?patient=mrn-1&a=1" })).toBe(
      "/sign-in?redirect_url=" + encodeURIComponent("/dashboard"),
    );
    // a trailing slash is the same page, and comes back as the canonical path
    expect(signInUrlAfterSignOut("", { pathname: "/accept-invite/", search: "?token=abc" })).toBe(
      "/sign-in?redirect_url=" + encodeURIComponent("/accept-invite?token=abc"),
    );
    // an invitation keeps its token (and only that)
    expect(signInUrlAfterSignOut("", { pathname: "/accept-invite", search: "?token=abc&x=1" })).toBe(
      "/sign-in?redirect_url=" + encodeURIComponent("/accept-invite?token=abc"),
    );
  });

  it("stops exempting a call after the cap (a stuck flag cannot extend a session forever)", () => {
    setCallInProgress(true, 0);
    expect(isCallInProgress(MAX_CALL_EXEMPTION_MS - 1000)).toBe(true);
    expect(isCallInProgress(MAX_CALL_EXEMPTION_MS + 1000)).toBe(false);
    setCallInProgress(false);
  });
});

describe("isUsingEmbeddedDocument", () => {
  it("is false without a window/document (node)", () => {
    expect(isUsingEmbeddedDocument()).toBe(false);
  });

  it("keeps recording activity in memory if storage stops working mid-session", () => {
    const m = fakeStorage();
    markActivity(1_000_000);
    const store = (globalThis as any).localStorage;
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    markActivity(5_000_000);
    expect(m.get(LAST_ACTIVITY_KEY)).toBe("1000000"); // the write was refused...
    expect(staleReason(30, 5_000_000 + MIN)).toBeNull(); // ...but the activity wasn't lost
    clearSessionMarkers();
  });

  it("recovers when storage comes back after a brief failure (a 'no' is not permanent)", () => {
    vi.useFakeTimers();
    try {
      fakeStorage();
      markActivity(1_000_000);
      const store = (globalThis as any).localStorage;
      const realSet = store.setItem;
      store.setItem = () => {
        throw new Error("QuotaExceededError");
      };
      markActivity(2_000_000); // both writes fail; the "no" may get cached
      store.setItem = realSet; // storage recovers
      vi.advanceTimersByTime(31_000);
      markActivity(3_000_000);
      expect(store.getItem(LAST_ACTIVITY_KEY)).toBe("3000000"); // writing to storage again
      clearSessionMarkers();
    } finally {
      vi.useRealTimers();
    }
  });

  function stubStorage(initiallyBlocked: boolean) {
    const m = new Map<string, string>();
    const state = { blocked: initiallyBlocked };
    const stub: Storage = {
      getItem: (k) => (m.has(k) ? m.get(k)! : null),
      setItem: (k, v) => {
        if (state.blocked) throw new Error("blocked");
        m.set(k, v);
      },
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      get length() {
        return m.size;
      },
      key: (i) => Array.from(m.keys())[i] ?? null,
    };
    (globalThis as any).localStorage = stub;
    return { m, state };
  }

  it("re-checks storage after the 30s window when it was unavailable at first", () => {
    vi.useFakeTimers();
    try {
      const { state } = stubStorage(true);
      expect(storageAvailable()).toBe(false);
      state.blocked = false;
      expect(storageAvailable()).toBe(false); // still inside the window: cached "no"
      vi.advanceTimersByTime(31_000);
      expect(storageAvailable()).toBe(true); // recovered
    } finally {
      vi.useRealTimers();
      clearSessionMarkers();
    }
  });

  it("carries memory-held activity into storage when it becomes available (no false 'reopened')", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10 * MIN);
      const { m, state } = stubStorage(true);
      markActivity(Date.now()); // held in memory while blocked
      expect(staleReason(30, Date.now())).toBeNull();
      state.blocked = false;
      vi.advanceTimersByTime(31_000);
      // storage is usable again; the recorded activity must come with it
      expect(staleReason(30, Date.now())).toBeNull();
      expect(m.get(LAST_ACTIVITY_KEY)).toBeDefined();
    } finally {
      vi.useRealTimers();
      clearSessionMarkers();
    }
  });

  it("does not overwrite a fresher timestamp another tab wrote while this one was blocked", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10 * MIN);
      const { m, state } = stubStorage(true);
      markActivity(5 * MIN); // old value held in memory
      m.set(LAST_ACTIVITY_KEY, String(10 * MIN)); // another tab's newer write
      m.set(LAST_SEEN_KEY, String(10 * MIN));
      state.blocked = false;
      vi.advanceTimersByTime(31_000);
      storageAvailable();
      expect(m.get(LAST_ACTIVITY_KEY)).toBe(String(10 * MIN));
    } finally {
      vi.useRealTimers();
      clearSessionMarkers();
    }
  });

  it("keeps the agency timeout learned while blocked when storage has none on recovery", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10 * MIN);
      const { m, state } = stubStorage(true);
      saveIdleMinutes(5); // learned from the API while storage was blocked
      state.blocked = false;
      vi.advanceTimersByTime(31_000);
      storageAvailable();
      expect(m.get(IDLE_MINUTES_KEY)).toBe("5");
    } finally {
      vi.useRealTimers();
      clearSessionMarkers();
    }
  });

  it("leaves the agency timeout in storage alone on recovery (the status refresh rewrites it)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10 * MIN);
      const { m, state } = stubStorage(true);
      saveIdleMinutes(30); // held in memory while blocked
      m.set(IDLE_MINUTES_KEY, "15"); // another tab stored a different value
      state.blocked = false;
      vi.advanceTimersByTime(31_000);
      storageAvailable();
      expect(m.get(IDLE_MINUTES_KEY)).toBe("15");
      saveIdleMinutes(10); // a later status refresh still lands
      expect(m.get(IDLE_MINUTES_KEY)).toBe("10");
    } finally {
      vi.useRealTimers();
      clearSessionMarkers();
    }
  });

  it("keeps using memory when the carry-over fails partway (no false 'reopened')", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10 * MIN);
      const { m, state } = stubStorage(true);
      markActivity(Date.now());
      state.blocked = false;
      const store = (globalThis as any).localStorage as Storage;
      const realSet = store.setItem.bind(store);
      store.setItem = (k: string, v: string) => {
        if (k === LAST_ACTIVITY_KEY) throw new Error("QuotaExceededError");
        realSet(k, v);
      };
      vi.advanceTimersByTime(31_000);
      expect(staleReason(30, Date.now() + 1000)).toBeNull(); // memory still answers
      expect(m.has(LAST_ACTIVITY_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
      clearSessionMarkers();
    }
  });
});
