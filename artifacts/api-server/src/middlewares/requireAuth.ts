import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Role, type Resource, type Action, can } from "../lib/permissions";

export type AuthenticatedRequest = Request & {
  userId: string;
  orgId: string;
  userRole: Role;
};

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;

  if (!clerkUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, clerkUserId))
    .limit(1);

  if (!user || !user.isActive) {
    res.status(401).json({ error: "User not found or inactive" });
    return;
  }

  const authReq = req as AuthenticatedRequest;
  authReq.userId = user.id;
  authReq.orgId = user.orgId;
  authReq.userRole = user.role as Role;

  next();
};

/**
 * Explicit-role middleware.
 *
 * Grants access when the authenticated user's role is one of the listed roles.
 * Use requirePermission() for resource/action matrix lookups — these two
 * helpers must never be conflated because role names can overlap resource names
 * (e.g. "agent" is both a Role and a Resource), which causes silent
 * authorization failures if a single overloaded function is used.
 */
export function requireRole(
  ...allowedRoles: Array<Role>
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const role = authReq.userRole;

    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

/**
 * Permission-matrix middleware.
 *
 * Consult the centralised RBAC matrix in lib/permissions.ts to decide access.
 * Prefer this over requireRole() when checking resource/action semantics so
 * the matrix stays the single source of truth.
 *
 * Separate from requireRole() to eliminate the "agent" role-vs-resource
 * ambiguity that would exist in a single overloaded function.
 */
export function requirePermission(
  resource: Resource,
  action: Action,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const role = authReq.userRole;

    if (!role || !can(role, resource, action)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

