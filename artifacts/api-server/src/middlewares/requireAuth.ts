import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { randomUUID } from "node:crypto";
import { db, usersTable, organizationsTable, orgSettingsTable, sessionActivityTable, auditLogTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";
import { type Role, type Resource, type Action, can } from "../lib/permissions";
import { isDemoMode, demoUserId } from "../lib/demoMode";
import { mfaEnforced, mfaEnrolledFromAuth, MFA_REQUIRED_MESSAGE } from "./requireMfa";

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

/**
 * Per-session inactivity tracking — durable DB-backed store.
 *
 * HIPAA/SOC 2 requirement: session timeout enforcement must survive process
 * restarts and be consistent across multiple instances. An in-memory Map is
 * process-local and resets on restart, creating a bypass risk.
 *
 * Implementation:
 * - Source of truth: `session_activity` table in PostgreSQL.
 * - Local write-through cache (60 s TTL) avoids a DB round-trip on every
 *   request while still flushing updated timestamps promptly.
 * - On startup the DB provides authoritative last-active timestamps.
 */
const sessionLocalCache = new Map<string, { lastActiveAt: number; syncedAt: number }>();
const SESSION_CACHE_SYNC_MS = 60_000; // re-read from DB after 60 s

async function checkAndUpdateSessionActivity(
  sessionId: string,
  orgId: string,
  timeoutMs: number,
): Promise<"ok" | "expired"> {
  const now = Date.now();
  const cached = sessionLocalCache.get(sessionId);
  const needsDbRead = !cached || now - cached.syncedAt > SESSION_CACHE_SYNC_MS;

  let lastActiveAt: number;

  if (needsDbRead) {
    const [row] = await db
      .select({ lastActiveAt: sessionActivityTable.lastActiveAt, expiresAt: sessionActivityTable.expiresAt })
      .from(sessionActivityTable)
      .where(eq(sessionActivityTable.sessionId, sessionId))
      .limit(1);

    if (row) {
      lastActiveAt = row.lastActiveAt.getTime();
      if (now > row.expiresAt.getTime()) {
        // Already expired in DB — clean up and reject
        await db.delete(sessionActivityTable).where(eq(sessionActivityTable.sessionId, sessionId));
        sessionLocalCache.delete(sessionId);
        return "expired";
      }
    } else {
      // First time seeing this session — treat as fresh
      lastActiveAt = now;
    }
    sessionLocalCache.set(sessionId, { lastActiveAt, syncedAt: now });
  } else {
    lastActiveAt = cached!.lastActiveAt;
  }

  if (now - lastActiveAt > timeoutMs) {
    // Timed out — remove from both stores
    await db.delete(sessionActivityTable).where(eq(sessionActivityTable.sessionId, sessionId));
    sessionLocalCache.delete(sessionId);
    return "expired";
  }

  // Active — upsert new last-active timestamp into DB
  const expiresAt = new Date(now + timeoutMs);
  await db
    .insert(sessionActivityTable)
    .values({ sessionId, orgId, lastActiveAt: new Date(now), expiresAt })
    .onConflictDoUpdate({
      target: sessionActivityTable.sessionId,
      set: { lastActiveAt: new Date(now), expiresAt },
    });
  sessionLocalCache.set(sessionId, { lastActiveAt: now, syncedAt: now });

  return "ok";
}

// Periodic cleanup of expired session rows and stale local cache entries.
// Runs every 15 minutes; won't block process exit.
setInterval(
  async () => {
    try {
      await db.delete(sessionActivityTable).where(lt(sessionActivityTable.expiresAt, new Date()));
    } catch {
      // non-fatal
    }
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [sid, entry] of sessionLocalCache) {
      if (entry.lastActiveAt < cutoff) sessionLocalCache.delete(sid);
    }
  },
  15 * 60 * 1000,
).unref();

export type AuthenticatedRequest = Request & {
  userId: string;
  orgId: string;
  userRole: Role;
  mfaEnrolled: boolean;
  realOrgId?: string;
  viewingOrgId?: string;
  viewOnly?: boolean;
  supportEdit?: boolean;
  supportReason?: string;
};

async function applyViewAsContext(
  req: Request,
  res: Response,
  authReq: AuthenticatedRequest,
  realOrgId: string,
): Promise<boolean> {
  const requestedOrgId = req.get("X-MediFlow-View-Org")?.trim();
  authReq.realOrgId = realOrgId;
  authReq.viewOnly = false;
  authReq.supportEdit = false;
  if (!requestedOrgId) return true;
  if (authReq.userRole !== "super_admin") {
    res.status(403).json({ error: "Only super admins can view an agency" });
    return false;
  }
  if (mfaEnforced() && !authReq.mfaEnrolled) {
    res.status(403).json({ error: "mfa_required", message: "Multi-factor authentication is required to view another agency." });
    return false;
  }
  const [organization] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, requestedOrgId))
    .limit(1);
  if (!organization) {
    res.status(404).json({ error: "Agency not found" });
    return false;
  }
  authReq.orgId = organization.id;
  authReq.viewingOrgId = organization.id;
  authReq.viewOnly = true;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    // Cross-agency writes are opt-in and limited to profile edits. Other
    // operations (messages, billing, exports, deletion, invitations) stay blocked.
    const supportEdit = req.get("X-MediFlow-Support-Edit") === "true";
    const reason = req.get("X-MediFlow-Support-Reason")?.trim() ?? "";
    const path = req.originalUrl.split("?")[0];
    const allowedPath = /^\/api\/(contacts|agents)\/[^/]+$/.test(path);
    if (!supportEdit || req.method.toUpperCase() !== "PATCH" || !allowedPath) {
      res.status(403).json({ error: "View-only mode does not allow this change", code: "VIEW_ONLY_MODE" });
      return false;
    }
    const resource = path.match(/^\/api\/(contacts|agents)\/[^/]+$/)?.[1];
    const allowedFields = resource === "contacts"
      ? new Set(["firstName", "lastName", "email", "phone", "county", "stateCode", "zipCode", "preferredLanguage"])
      : new Set(["firstName", "lastName", "email", "phone", "notes", "avatarUrl"]);
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).some((field) => !allowedFields.has(field))) {
      res.status(403).json({ error: "Support mode only permits basic profile fields", code: "SUPPORT_EDIT_SCOPE" });
      return false;
    }
    if (!authReq.mfaEnrolled || reason.length < 10 || reason.length > 240) {
      res.status(403).json({ error: "Support edits require MFA and a reason of 10–240 characters", code: "SUPPORT_EDIT_REQUIREMENTS" });
      return false;
    }
    // Persist the actor, target, and stated purpose before allowing a write.
    // A failed audit insert must leave the agency data unchanged.
    try {
      await db.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: organization.id,
        userId: authReq.userId,
        userRole: authReq.userRole,
        action: "update",
        resourceType: resource === "contacts" ? "contact" : "agent",
        resourceId: path.split("/").pop() ?? null,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        changes: { supportEdit: true, phase: "attempt", reason, realOrgId, viewingOrgId: organization.id, path },
      }).execute();
    } catch (err) {
      req.log.error({ err, realOrgId, viewingOrgId: organization.id }, "Support edit audit unavailable");
      res.status(503).json({ error: "Support edit audit unavailable", code: "SUPPORT_AUDIT_UNAVAILABLE" });
      return false;
    }
    authReq.viewOnly = false;
    authReq.supportEdit = true;
    authReq.supportReason = reason;
  }
  return true;
}
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Demo mode: bypass Clerk entirely and resolve every request to the seeded
  // demo user. Gated by isDemoMode() which is a hard no-op under
  // NODE_ENV=production, so this branch can never run in a real deploy.
  if (isDemoMode()) {
    const [demoUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, demoUserId()))
      .limit(1);

    if (!demoUser || !demoUser.isActive) {
      res.status(401).json({
        error: "Demo user not found — run `pnpm seed:demo` against this database",
      });
      return;
    }

    const authReq = req as AuthenticatedRequest;
    authReq.userId = demoUser.id;
    authReq.orgId = demoUser.orgId;
    authReq.userRole = demoUser.role as Role;
    // Treat the demo principal as MFA-enrolled so privileged routes (which
    // gate on this via requireMfa) are reachable in the walkthrough. No real
    // credentials exist in demo mode, so this only affects the seeded org.
    authReq.mfaEnrolled = true;
    if (!(await applyViewAsContext(req, res, authReq, demoUser.orgId))) return;
    authReq.log = req.log.child({ userId: demoUser.id, orgId: demoUser.orgId, role: demoUser.role, demo: true });

    next();
    return;
  }

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
    // Distinguish "signed in to Clerk but has no agencyBRIDGE account yet" from
    // "deactivated". The first is the normal state immediately after sign-up
    // and the web app answers it by showing the create-your-agency screen;
    // the second must bounce to sign-in. Both stay 401 — the code is what the
    // client branches on.
    res.status(401).json({
      error: user ? "User is inactive" : "User not provisioned",
      code: user ? "USER_INACTIVE" : "NOT_PROVISIONED",
    });
    return;
  }

  // Session inactivity enforcement — true idle timeout backed by durable DB store
  const sessionId = auth.sessionId;
  if (sessionId) {
    const sessionTimeoutMinutes = await getOrgSessionTimeout(user.orgId);
    const timeoutMs = sessionTimeoutMinutes * 60 * 1000;
    const result = await checkAndUpdateSessionActivity(sessionId, user.orgId, timeoutMs);
    if (result === "expired") {
      res.status(401).json({ error: "Session expired due to inactivity", code: "SESSION_TIMEOUT" });
      return;
    }
  }

  const mfaEnrolled = mfaEnrolledFromAuth(auth);

  const authReq = req as AuthenticatedRequest;
  authReq.userId = user.id;
  authReq.orgId = user.orgId;
  authReq.userRole = user.role as Role;
  authReq.mfaEnrolled = mfaEnrolled;
  if (!(await applyViewAsContext(req, res, authReq, user.orgId))) return;
  authReq.log = req.log.child({ userId: user.id, orgId: authReq.orgId, realOrgId: user.orgId, role: user.role, viewOnly: authReq.viewOnly, supportEdit: authReq.supportEdit });

  // HIPAA technical safeguard: every user, whatever their role, must have MFA
  // enrolled before any authenticated route answers. The web app reads
  // /auth/status (not behind this middleware) and shows the enrollment screen.
  if (mfaEnforced() && !mfaEnrolled) {
    res.status(403).json({ error: "mfa_required", code: "MFA_REQUIRED", message: MFA_REQUIRED_MESSAGE });
    return;
  }

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

/**
 * Step-up authentication gate — verifies the caller's Clerk JWT was issued
 * within `maxAgeSeconds` (default 15 min). Forces token freshness rather than
 * relying on a client-supplied header, providing cryptographic evidence for
 * HIPAA/SOC 2 audit trails.
 *
 * Frontend handling: on 401 { code: "STEP_UP_REQUIRED" }, call
 * `clerk.session.touch()` (or Clerk's re-auth flow) then retry the request.
 */
export function requireRecentAuth(maxAgeSeconds = 900): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = getAuth(req);
    const iat = typeof auth.sessionClaims?.iat === "number" ? auth.sessionClaims.iat : 0;
    if (!iat || Math.floor(Date.now() / 1000) - iat > maxAgeSeconds) {
      res.status(401).json({
        error: "Step-up authentication required — please re-authenticate to perform this sensitive operation",
        code: "STEP_UP_REQUIRED",
      });
      return;
    }
    next();
  };
}

/**
 * Bulk PHI export gate: requires both recent authentication (cryptographic
 * evidence via JWT iat) AND the explicit UI confirmation header.
 */
export function requireExportConfirm(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const iat = typeof auth.sessionClaims?.iat === "number" ? auth.sessionClaims.iat : 0;
  if (!iat || Math.floor(Date.now() / 1000) - iat > 900) {
    res.status(401).json({
      error: "Step-up authentication required — re-authenticate before exporting PHI",
      code: "STEP_UP_REQUIRED",
    });
    return;
  }
  if (req.headers["x-confirm-export"] !== "true") {
    res.status(428).json({
      error: "Export confirmation required",
      code: "EXPORT_CONFIRM_REQUIRED",
      hint: "Include header X-Confirm-Export: true to proceed with bulk data export",
    });
    return;
  }
  next();
}

/**
 * Hard-delete / irreversible operation gate: requires both recent
 * authentication (JWT iat check) AND the explicit UI confirmation header.
 */
export function requireDestructiveConfirm(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const iat = typeof auth.sessionClaims?.iat === "number" ? auth.sessionClaims.iat : 0;
  if (!iat || Math.floor(Date.now() / 1000) - iat > 900) {
    res.status(401).json({
      error: "Step-up authentication required — re-authenticate before this irreversible operation",
      code: "STEP_UP_REQUIRED",
    });
    return;
  }
  if (req.headers["x-confirm-destructive"] !== "true") {
    res.status(428).json({
      error: "Destructive operation confirmation required",
      code: "DESTRUCTIVE_CONFIRM_REQUIRED",
      hint: "Include header X-Confirm-Destructive: true to proceed",
    });
    return;
  }
  next();
}
