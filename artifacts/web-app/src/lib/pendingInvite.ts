/**
 * Remembers an invitation link across sign-up.
 *
 * The invitation token lives only in the accept-invite URL. Signing up with
 * Clerk can lose that URL: the email-verification link opens in a new tab, MFA
 * enrolment redirects, or the sign-up form simply lands on the default page.
 * The person then reaches the provisioning gate with no agency account and is
 * shown "Create your agency" — and if they create one, the invitation can never
 * be accepted ("this account already belongs to an agency").
 *
 * So the accept-invite page remembers the token here, and the gate sends an
 * unprovisioned user back to that page instead of to agency creation.
 *
 * Storage is `localStorage`, not `sessionStorage`, because the verification
 * email opens a different tab. The token is a single-use credential that only
 * grants the invited role in the inviting agency, so it expires with the
 * invitation itself (7 days) and is cleared the moment it is used or found
 * unusable. Every access is wrapped: storage can be blocked or throw.
 */

const KEY = "mediflow:pending-invite";

/** Matches the server's invitation lifetime (`INVITE_TTL_DAYS`). */
export const PENDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The server mints 32 random bytes as base64url (43 chars); reject junk early. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

interface Stored {
  token: string;
  savedAt: number;
}

export function rememberPendingInvite(token: string, now: number = Date.now()): void {
  if (!TOKEN_SHAPE.test(token)) return;
  try {
    const value: Stored = { token, savedAt: now };
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable (private window, blocked site data): the URL still works.
  }
}

export function readPendingInvite(now: number = Date.now()): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.savedAt !== "number" ||
      !TOKEN_SHAPE.test(parsed.token) ||
      now - parsed.savedAt > PENDING_INVITE_TTL_MS ||
      parsed.savedAt > now + 60_000
    ) {
      clearPendingInvite();
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Path (without the app base) to send an unprovisioned user to, or null when
 * they have no invitation to return to.
 */
export function pendingInvitePath(now: number = Date.now()): string | null {
  const token = readPendingInvite(now);
  return token ? `/accept-invite?token=${encodeURIComponent(token)}` : null;
}
