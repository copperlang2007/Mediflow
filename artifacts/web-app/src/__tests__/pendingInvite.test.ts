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
  setPendingInviteExpiry,
  pendingInvitePath,
  PENDING_INVITE_TTL_MS,
} from "@/lib/pendingInvite";

const TOKEN = "test-invite-token-0123456789";

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

describe("expiry and clearing", () => {
  it("stops returning the link once the invitation's real expiry has passed", () => {
    const now = Date.now();
    rememberPendingInvite(TOKEN, now);
    setPendingInviteExpiry(TOKEN, new Date(now + 60_000).toISOString());
    expect(readPendingInvite(now + 30_000)).toBe(TOKEN);
    expect(readPendingInvite(now + 61_000)).toBeNull();
  });

  it("keeps the learned expiry when the same link is opened again", () => {
    const now = Date.now();
    rememberPendingInvite(TOKEN, now);
    setPendingInviteExpiry(TOKEN, new Date(now + 60_000).toISOString());
    rememberPendingInvite(TOKEN, now + 1_000);
    expect(readPendingInvite(now + 61_000)).toBeNull();
  });

  it("ignores an expiry for a link that is not the remembered one", () => {
    const now = Date.now();
    rememberPendingInvite(TOKEN, now);
    setPendingInviteExpiry("another-invite-token-0123456789", new Date(now - 1).toISOString());
    expect(readPendingInvite(now)).toBe(TOKEN);
  });

  it("only clears when the remembered link is the one being cleared", () => {
    rememberPendingInvite(TOKEN);
    clearPendingInvite("another-invite-token-0123456789");
    expect(readPendingInvite()).toBe(TOKEN);
    clearPendingInvite(TOKEN);
    expect(readPendingInvite()).toBeNull();
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
