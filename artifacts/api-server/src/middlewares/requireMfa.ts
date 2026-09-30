import type { Request, Response, NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { type AuthenticatedRequest } from "./requireAuth";
import { logger } from "../lib/logger";

// HIPAA technical safeguard: every user must have MFA enrolled. requireAuth
// enforces it on every authenticated request; requireMfa repeats the check on
// the most sensitive routes (admin, commissions, call scoring, full
// applications) so they stay gated even if a router is ever mounted without
// requireAuth's check. Both read the MFA-enrolled flag from the Clerk session.

export const MFA_REQUIRED_MESSAGE =
  "Multi-factor authentication is required. Turn on two-step verification in Account security, then sign in again.";

/**
 * Whether the MFA gate is enforced. Only the test suite (synthetic auth
 * headers carry no MFA claim) and local development may switch it off with
 * MFA_REQUIRED=false. Production always enforces: the flag is ignored there,
 * so an inherited or mistyped env var can't silently disable MFA on PHI routes.
 */
export function mfaEnforced(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.MFA_REQUIRED === "false" && process.env.NODE_ENV !== "production") return false;
  return true;
}

/**
 * MFA enrollment from a Clerk auth object. Clerk exposes the user's second
 * factor as `two_factor` (or `two_factor_authentication` / `mfa`) in the
 * session claims; older SDKs put it on `auth.user.twoFactorEnabled`. All are
 * checked so a deployment configured either way still flows through.
 * Set up in Clerk (Sessions > Customize session token):
 *   { "two_factor": "{{user.two_factor_enabled}}" }
 * A template shortcode may arrive as the string "true", so both forms count.
 */
export function mfaEnrolledFromAuth(auth: unknown): boolean {
  const a = (auth ?? {}) as { sessionClaims?: unknown; user?: { twoFactorEnabled?: boolean } };
  const claims = (a.sessionClaims ?? {}) as Record<string, unknown>;
  const isOn = (v: unknown) => v === true || v === "true";
  return isOn(claims.two_factor) || isOn(claims.two_factor_authentication) || isOn(claims.mfa)
    || a.user?.twoFactorEnabled === true;
}

const MFA_CLAIMS = ["two_factor", "two_factor_authentication", "mfa"] as const;
// Positives are kept a minute; negatives only a few seconds, so a user who
// just enrolled isn't told "not on yet" by a stale entry. Capped, oldest out.
const ENROLLED_TTL_MS = 60_000;
const NOT_ENROLLED_TTL_MS = 5_000;
const LOOKUP_MAX = 5_000;
const lookupCache = new Map<string, { enrolled: boolean; at: number }>();
let lastMissingClaimWarning = 0;

/**
 * MFA enrollment for a request. Reads the session claim; when the token
 * carries no MFA claim at all (the Clerk session-token template is missing),
 * asks Clerk's backend API instead, cached for a minute per user, and logs a
 * distinct warning so a missing template is diagnosable rather than a
 * lockout of every user. A failed lookup counts as not enrolled (fail
 * closed); the session-token template is the real fix, see above.
 */
export async function resolveMfaEnrolled(auth: unknown): Promise<boolean> {
  if (mfaEnrolledFromAuth(auth)) return true;
  const a = (auth ?? {}) as { userId?: unknown; sessionClaims?: unknown };
  const claims = (a.sessionClaims ?? {}) as Record<string, unknown>;
  if (MFA_CLAIMS.some((k) => k in claims)) return false;
  if (typeof a.userId !== "string" || !a.userId) return false;

  if (Date.now() - lastMissingClaimWarning > 10 * 60_000) {
    lastMissingClaimWarning = Date.now();
    logger.warn(
      { event: "mfa_claim_absent_from_jwt" },
      "Clerk session token has no two_factor claim; add { \"two_factor\": \"{{user.two_factor_enabled}}\" } under Sessions > Customize session token. Falling back to the Clerk API.",
    );
  }
  const cached = lookupCache.get(a.userId);
  const ttl = cached?.enrolled ? ENROLLED_TTL_MS : NOT_ENROLLED_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.enrolled;
  try {
    const user = await clerkClient.users.getUser(a.userId);
    const enrolled = user.twoFactorEnabled === true;
    lookupCache.delete(a.userId);
    if (lookupCache.size >= LOOKUP_MAX) {
      const oldest = lookupCache.keys().next().value;
      if (oldest !== undefined) lookupCache.delete(oldest);
    }
    lookupCache.set(a.userId, { enrolled, at: Date.now() });
    return enrolled;
  } catch (err) {
    logger.error({ err, event: "mfa_lookup_failed" }, "Clerk user lookup for MFA failed");
    return false;
  }
}

export function requireMfa(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authReq = req as AuthenticatedRequest;
  if (!mfaEnforced() || authReq.mfaEnrolled === true) {
    next();
    return;
  }
  res.status(403).json({ error: "mfa_required", code: "MFA_REQUIRED", message: MFA_REQUIRED_MESSAGE });
}
