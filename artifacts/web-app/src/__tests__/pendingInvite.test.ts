// @vitest-environment jsdom
/**
 * The remembered-invitation helper is what stops a freshly signed-up invitee
 * from being sent to "Create your agency" (and from there into a second, empty
 * org that makes the invitation unusable). The properties that matter: it
 * survives what sign-up does to the URL, it never outlives the invitation, and
 * it never throws when storage is unavailable.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  rememberPendingInvite,
  readPendingInvite,
  clearPendingInvite,
  pendingInvitePath,
  PENDING_INVITE_TTL_MS,
} from "@/lib/pendingInvite";

const TOKEN = "q3Zk8mP0xV1nC7bR2tY6uHdLsA9eWfGj4oIiKlMnOpQ";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remembering an invitation", () => {
  it("returns the token that was remembered", () => {
    rememberPendingInvite(TOKEN);
    expect(readPendingInvite()).toBe(TOKEN);
  });

  it("builds the accept-invite path for the gate to send people back to", () => {
    rememberPendingInvite(TOKEN);
    expect(pendingInvitePath()).toBe(`/accept-invite?token=${TOKEN}`);
  });

  it("has nothing to return to when nothing was remembered", () => {
    expect(readPendingInvite()).toBeNull();
    expect(pendingInvitePath()).toBeNull();
  });

  it("forgets the token once it is cleared", () => {
    rememberPendingInvite(TOKEN);
    clearPendingInvite();
    expect(readPendingInvite()).toBeNull();
  });

  it("does not outlive the invitation", () => {
    const savedAt = 1_000_000;
    rememberPendingInvite(TOKEN, savedAt);
    expect(readPendingInvite(savedAt + PENDING_INVITE_TTL_MS - 1)).toBe(TOKEN);
    expect(readPendingInvite(savedAt + PENDING_INVITE_TTL_MS + 1)).toBeNull();
    // And an expired entry is removed, not merely ignored.
    expect(window.localStorage.getItem("mediflow:pending-invite")).toBeNull();
  });

  it("refuses to remember an empty token", () => {
    rememberPendingInvite("");
    expect(readPendingInvite()).toBeNull();
    expect(pendingInvitePath()).toBeNull();
  });

  it("refuses to remember something that is not shaped like a token", () => {
    rememberPendingInvite("short");
    rememberPendingInvite("not a token because it has spaces and is long enough");
    expect(readPendingInvite()).toBeNull();
  });

  it("ignores and clears a corrupted entry instead of throwing", () => {
    window.localStorage.setItem("mediflow:pending-invite", "{not json");
    expect(readPendingInvite()).toBeNull();

    window.localStorage.setItem(
      "mediflow:pending-invite",
      JSON.stringify({ token: "../../evil", savedAt: Date.now() }),
    );
    expect(readPendingInvite()).toBeNull();
    expect(window.localStorage.getItem("mediflow:pending-invite")).toBeNull();
  });
});

describe("when storage is unavailable", () => {
  it("never throws, so a blocked-storage browser still gets the URL flow", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => rememberPendingInvite(TOKEN)).not.toThrow();
    expect(readPendingInvite()).toBeNull();
    expect(() => clearPendingInvite()).not.toThrow();
  });
});
