/**
 * Browser-side session rules.
 *
 * Clerk keeps its sign-in cookie for days, and the API only notices
 * inactivity when a request is made. Without these rules, typing the site
 * address in a new tab finds a still-valid cookie and goes straight to the
 * dashboard. The rules below make the browser end the session itself:
 *
 *  - idle: no mouse/keyboard/touch in any tab for the timeout -> sign out.
 *  - reopen: no tab has been open for a few minutes (browser closed, laptop
 *    asleep, or the user simply came back later) -> sign out, so the next
 *    visit always starts at the sign-in screen.
 *
 * Timestamps live in localStorage so every tab agrees.
 */

export const LAST_ACTIVITY_KEY = "mediflow:lastActivityAt";
export const LAST_SEEN_KEY = "mediflow:lastSeenAt";
export const SESSION_EXPIRED_EVENT = "mediflow:session-expired";

/** Used until the agency's own setting (Admin > Compliance) is known. */
export const DEFAULT_IDLE_MINUTES = 30;

/**
 * How long with no open tab counts as "left the app". Background tabs can
 * be throttled to one timer tick a minute, so this must stay well above that.
 */
export const REOPEN_GRACE_MS = 3 * 60 * 1000;

export type StaleReason = "reopened" | "idle";

function read(key: string): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, value: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    // Storage can be blocked; the server-side timeout still applies.
  }
}

export const markActivity = (now = Date.now()): void => {
  write(LAST_ACTIVITY_KEY, now);
  write(LAST_SEEN_KEY, now);
};

export const markSeen = (now = Date.now()): void => write(LAST_SEEN_KEY, now);

export function clearSessionMarkers(): void {
  try {
    globalThis.localStorage?.removeItem(LAST_ACTIVITY_KEY);
    globalThis.localStorage?.removeItem(LAST_SEEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Should an already-signed-in browser be signed out right now?
 * Missing timestamps (first run after this fix shipped, or cleared storage)
 * count as stale: when in doubt, ask for the password.
 */
export function staleReason(idleMinutes: number, now = Date.now()): StaleReason | null {
  const lastSeen = read(LAST_SEEN_KEY);
  const lastActivity = read(LAST_ACTIVITY_KEY);
  if (lastSeen === null || lastActivity === null) return "reopened";
  if (now - lastSeen > REOPEN_GRACE_MS) return "reopened";
  if (now - lastActivity > idleMinutes * 60 * 1000) return "idle";
  return null;
}

/** Tell the app the API said the session is over (see queryClient.ts). */
export function announceSessionExpired(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
