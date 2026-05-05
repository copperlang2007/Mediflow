import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type AuthenticatedRequest = Request & {
  userId: string;
  orgId: string;
  userRole: string;
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
  authReq.userRole = user.role;

  next();
};

export const requireRole = (
  ...roles: Array<"super_admin" | "agency_admin" | "compliance_manager" | "agent">
) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.userRole || !roles.includes(authReq.userRole as any)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
};
