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
export const IDLE_MINUTES_KEY = "mediflow:idleMinutes";
export const SESSION_EXPIRED_EVENT = "mediflow:session-expired";
export const CALL_ENDED_EVENT = "mediflow:call-ended";

/** Used until the agency's own setting (Admin > Compliance) is known. */
export const DEFAULT_IDLE_MINUTES = 30;

/**
 * How long with no open tab counts as "left the app". Background tabs can
 * be throttled to one timer tick a minute, so this must stay well above that.
 */
export const REOPEN_GRACE_MS = 3 * 60 * 1000;

const CLOCK_SKEW_MS = 60 * 1000; // routine clock corrections (wake from sleep, airplane mode)

export type StaleReason = "reopened" | "idle";

/**
 * False when the browser blocks storage (some private modes). Then the
 * browser-side rules cannot work, so they stand down and the server-side
 * timeout is the only enforcement. Without this, "no record" would read as
 * "left the app" and sign the user out again every few seconds.
 */
// The probe writes and removes a key, which also notifies other open tabs, so
// the answer is remembered for as long as the browser's storage object is the
// same one (a different object, e.g. in tests, is probed afresh).
let probedStore: Storage | undefined;
let probedResult = false;

export function storageAvailable(): boolean {
  let store: Storage | undefined;
  try {
    store = globalThis.localStorage;
  } catch {
    return false;
  }
  if (store === undefined) return false;
  if (store === probedStore) return probedResult;
  let ok = false;
  try {
    store.setItem("mediflow:probe", "1");
    store.removeItem("mediflow:probe");
    ok = true;
  } catch {
    ok = false;
  }
  probedStore = store;
  probedResult = ok;
  return ok;
}

/** The agency's idle limit as last reported by the API, for the next page load. */
export function storedIdleMinutes(): number | null {
  const n = read(IDLE_MINUTES_KEY);
  return n !== null && n > 0 ? n : null;
}

export const saveIdleMinutes = (minutes: number): void => write(IDLE_MINUTES_KEY, minutes);

// When the browser blocks storage, the idle clock lives in memory for this
// page only. Idle logout still works; the "came back later" rule can't (there
// is nothing to remember across page loads), so it stands down.
const memory = new Map<string, number>();

function read(key: string): number | null {
  if (!storageAvailable()) return memory.get(key) ?? null;
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, value: number): void {
  if (!storageAvailable()) {
    memory.set(key, value);
    return;
  }
  try {
    globalThis.localStorage.setItem(key, String(value));
  } catch {
    // Storage stopped working mid-session (quota, eviction): forget the cached
    // probe and keep the value in memory so writes are never silently lost.
    probedStore = undefined;
    probedResult = false;
    memory.set(key, value);
  }
}

export const markActivity = (now = Date.now()): void => {
  write(LAST_ACTIVITY_KEY, now);
  write(LAST_SEEN_KEY, now);
};

export const markSeen = (now = Date.now()): void => write(LAST_SEEN_KEY, now);

export function clearSessionMarkers(): void {
  memory.clear();
  try {
    globalThis.localStorage?.removeItem(LAST_ACTIVITY_KEY);
    globalThis.localStorage?.removeItem(LAST_SEEN_KEY);
    globalThis.localStorage?.removeItem(IDLE_MINUTES_KEY);
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
  const available = storageAvailable();
  const lastSeen = read(LAST_SEEN_KEY);
  const lastActivity = read(LAST_ACTIVITY_KEY);
  if (lastSeen === null || lastActivity === null) {
    // Nothing recorded: an old cookie, unless storage is blocked (then nothing
    // can ever be recorded before the first activity, so don't loop on it).
    return available ? "reopened" : null;
  }
  // A clock that moved backwards must not make old activity look current.
  if (now < lastSeen - CLOCK_SKEW_MS || now < lastActivity - CLOCK_SKEW_MS) return "reopened";
  if (available && now - lastSeen > REOPEN_GRACE_MS) return "reopened";
  if (now - lastActivity > idleMinutes * 60 * 1000) return "idle";
  return null;
}

/** Tell the app the API said the session is over (see queryClient.ts). */
export function announceSessionExpired(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// A live phone call counts as activity: nobody touches the mouse for a whole
// call, and signing them out mid-call would drop it. The dialer keeps this
// flag in step with its call state.
// The exemption is capped so a flag that gets stuck (a dialer that never
// reports the call ended) cannot keep a session alive indefinitely.
export const MAX_CALL_EXEMPTION_MS = 4 * 60 * 60 * 1000;
let callInProgress = false;
let callStartedAt = 0;
export const setCallInProgress = (live: boolean, now = Date.now()): void => {
  const wasLive = callInProgress;
  if (live && !callInProgress) callStartedAt = now;
  callInProgress = live;
  // Lets the session guard act at once on an expiry it held back during the call.
  if (wasLive && !live && typeof window !== "undefined") window.dispatchEvent(new Event(CALL_ENDED_EVENT));
};
export const isCallInProgress = (now = Date.now()): boolean =>
  callInProgress && now - callStartedAt < MAX_CALL_EXEMPTION_MS;

/** Query parameters that may be carried through a forced sign-out, by page. */
const RETURN_PARAMS: Record<string, readonly string[]> = {
  "/accept-invite": ["token"],
};

/**
 * Where to send someone after a forced sign-out: the sign-in screen, which
 * returns them to the page they were on. Only the page path is kept, plus the
 * few parameters in RETURN_PARAMS (an invitation's token); other query strings
 * (identifiers, one-time codes) are never copied into the sign-in address.
 */
export function signInUrlAfterSignOut(basePath: string, loc: { pathname: string; search: string }): string {
  const signIn = `${basePath}/sign-in`;
  const rawRel = loc.pathname.startsWith(basePath) ? loc.pathname.slice(basePath.length) : loc.pathname;
  // `/accept-invite/` and `/accept-invite` are the same page.
  const rel = rawRel.length > 1 ? rawRel.replace(/\/+$/, "") : rawRel;
  if (rel === "" || rel === "/" || rel.startsWith("/sign-in") || rel.startsWith("/sign-up")) return signIn;
  const allowed = RETURN_PARAMS[rel] ?? [];
  const kept = new URLSearchParams();
  const incoming = new URLSearchParams(loc.search);
  for (const key of allowed) {
    const v = incoming.get(key);
    if (v !== null) kept.set(key, v);
  }
  const query = kept.toString();
  const here = loc.pathname + (query ? `?${query}` : "");
  return `${signIn}?redirect_url=${encodeURIComponent(here)}`;
}

/**
 * True while the user is working inside the document frame on the contract
 * signing page. Their clicks happen in a cross-origin frame, where this page
 * cannot see them. Deliberately narrow: only the signing route (exactly
 * `/sign/<id>`), and only while focus is in a frame, so other embedded widgets
 * (payment, chat, call widgets) never switch idle sign-out off.
 */
export function isUsingEmbeddedDocument(basePath = ""): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  const path = window.location.pathname;
  const rel = path.startsWith(basePath) ? path.slice(basePath.length) : path;
  if (!/^\/sign\/[^/]+\/?$/.test(rel)) return false;
  return document.activeElement?.tagName === "IFRAME";
}
