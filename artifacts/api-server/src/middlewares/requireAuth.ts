import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, usersTable, orgSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Role, type Resource, type Action, can } from "../lib/permissions";

// TTL cache for org session timeout settings (refresh every 60 s)
const orgTimeoutCache = new Map<string, { timeoutMinutes: number; fetchedAt: number }>();

async function getOrgSessionTimeout(orgId: string): Promise<number> {
  const cached = orgTimeoutCache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.timeoutMinutes;
  const [settings] = await db
    .select({ sessionTimeoutMinutes: orgSettingsTable.sessionTimeoutMinutes })
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.orgId, orgId))
    .limit(1);
  const timeoutMinutes = settings?.sessionTimeoutMinutes ?? 30;
  orgTimeoutCache.set(orgId, { timeoutMinutes, fetchedAt: Date.now() });
  return timeoutMinutes;
}

// Per-session inactivity tracking: sessionId → last-activity epoch ms
// True idle timeout — NOT token-age based. Cleaned up every 15 min.
const sessionLastActivity = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // discard entries >2 h old regardless
  for (const [sid, ts] of sessionLastActivity) {
    if (ts < cutoff) sessionLastActivity.delete(sid);
  }
}, 15 * 60 * 1000).unref();

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

  // Session inactivity enforcement — true idle timeout (not token-age)
  const sessionId = auth.sessionId;
  if (sessionId) {
    const sessionTimeoutMinutes = await getOrgSessionTimeout(user.orgId);
    const now = Date.now();
    const lastActivity = sessionLastActivity.get(sessionId);
    if (lastActivity !== undefined && now - lastActivity > sessionTimeoutMinutes * 60 * 1000) {
      sessionLastActivity.delete(sessionId);
      res.status(401).json({ error: "Session expired due to inactivity", code: "SESSION_TIMEOUT" });
      return;
    }
    sessionLastActivity.set(sessionId, now);
  }

  const authReq = req as AuthenticatedRequest;
  authReq.userId = user.id;
  authReq.orgId = user.orgId;
  authReq.userRole = user.role as Role;
  authReq.log = req.log.child({ userId: user.id, orgId: user.orgId, role: user.role });

  next();
};

export function requireRole(
  ...allowedRoles: Array<Role>
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.userRole || !allowedRoles.includes(authReq.userRole)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

export function requirePermission(
  resource: Resource,
  action: Action,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.userRole || !can(authReq.userRole, resource, action)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}
