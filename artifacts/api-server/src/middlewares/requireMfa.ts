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
  // In test mode (synthetic x-test-* headers from testApp), skip — the
  // helper headers don't carry MFA claims. Real Clerk sessions do.
  if (process.env.NODE_ENV === "test") {
    next();
    return;
  }
  // Skip enforcement when explicitly disabled (e.g. local dev without
  // Clerk's 2FA configured). Default in prod is enforce.
  if (process.env.MFA_REQUIRED === "false") {
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
