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
 * Role-based middleware. Accepts explicit roles OR a resource/action pair from
 * the centralized permission matrix. Prefer resource/action form so the matrix
 * stays as the single source of truth.
 */
export function requireRole(
  ...roles: Array<Role>
): (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function requireRole(
  resource: Resource,
  action: Action,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function requireRole(
  ...args: Array<Role | Resource | Action>
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const role = authReq.userRole;

    if (!role) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    let allowed = false;

    if (
      args.length === 2 &&
      typeof args[0] === "string" &&
      typeof args[1] === "string" &&
      !isRole(args[0])
    ) {
      allowed = can(role, args[0] as Resource, args[1] as Action);
    } else {
      allowed = (args as Role[]).includes(role);
    }

    if (!allowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

function isRole(value: string): value is Role {
  return (
    ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent"] as const
  ).includes(value as Role);
}
