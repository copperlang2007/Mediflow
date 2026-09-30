import type { Request, Response, NextFunction } from "express";
import { type AuthenticatedRequest } from "./requireAuth";

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
