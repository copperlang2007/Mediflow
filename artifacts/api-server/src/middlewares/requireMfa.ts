import type { Request, Response, NextFunction } from "express";
import { type AuthenticatedRequest } from "./requireAuth";

// HIPAA technical safeguard: privileged roles must have MFA enrolled.
// Reads the MFA-enrolled flag from the Clerk session (already present
// in the JWT claims for any user with a 2FA factor configured).
//
// Roles that must have MFA enrolled to access:
const MFA_REQUIRED_ROLES = new Set([
  "super_admin",
  "agency_admin",
  "compliance_manager",
  "developer",
]);

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
  if (!MFA_REQUIRED_ROLES.has(authReq.userRole)) {
    next();
    return;
  }
  if (!mfaEnforced()) {
    next();
    return;
  }
  const hasMfa = authReq.mfaEnrolled === true;
  if (!hasMfa) {
    res.status(403).json({
      error: "mfa_required",
      message:
        "Multi-factor authentication is required for this role. Enroll an MFA factor in your account settings.",
    });
    return;
  }
  next();
}
