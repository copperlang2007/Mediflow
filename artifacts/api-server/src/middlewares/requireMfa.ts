import type { Request, Response, NextFunction } from "express";
import { type AuthenticatedRequest } from "./requireAuth";

// HIPAA technical safeguard: every user must have MFA enrolled. requireAuth
// enforces it on every authenticated request; requireMfa repeats the check on
// the most sensitive routes (admin, commissions, call scoring, full
// applications) so they stay gated even if a router is ever mounted without
// requireAuth's check. Both read whether this sign-in passed a second factor
// from the verified Identity Platform token (lib/auth/identity.ts).

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
