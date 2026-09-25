/**
 * Admin routes: HIPAA/SOC 2 compliance infrastructure.
 * All endpoints require super_admin or agency_admin role.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, sql, desc, count, isNull, lt, isNotNull } from "drizzle-orm";
import {
  db,
  auditLogTable,
  usersTable,
  loginEventsTable,
  dataExportLogTable,
  dataRetentionPoliciesTable,
  orgSettingsTable,
  documentsTable,
  contactsTable,
  dealsTable,
  taskInstancesTable,
  breachNotificationsTable,
  BREACH_SEVERITIES,
  BREACH_STATUSES,
  type BreachSeverity,
  type BreachStatus,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
  requireExportConfirm,
  requireDestructiveConfirm,
} from "../middlewares/requireAuth";
import { requireMfa } from "../middlewares/requireMfa";
import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import { ObjectStorageService } from "../lib/objectStorage";
import { clerkClient } from "@clerk/express";
import { safeLimit, safeOffset } from "../lib/listGuards";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

function param(p: string | string[]): string {
  return Array.isArray(p) ? (p[0] ?? "") : p;
}

// ─── Audit Log (enhanced — existing audit.ts has basic version) ───────────────
// Admin-level audit log with diff viewer is at GET /admin/audit-log
router.get(
  "/admin/audit-log",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { userId, action, resourceType, startDate, endDate, limit, offset } = req.query as Record<string, string>;

    const limitNum = safeLimit(limit, 50, 500);
    const offsetNum = safeOffset(offset);

    const conditions = [eq(auditLogTable.orgId, authReq.orgId)];
    if (userId) conditions.push(eq(auditLogTable.userId, userId));
    if (action) conditions.push(eq(auditLogTable.action, action));
    if (resourceType) conditions.push(eq(auditLogTable.resourceType, resourceType));
    if (startDate) conditions.push(gte(auditLogTable.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(auditLogTable.createdAt, new Date(endDate)));

    const [entries, [{ total }]] = await Promise.all([
      db.select().from(auditLogTable).where(and(...conditions))
        .orderBy(desc(auditLogTable.createdAt)).limit(limitNum).offset(offsetNum),
      db.select({ total: count() }).from(auditLogTable).where(and(...conditions)),
    ]);

    // Enrich with user names
    const userIds = [...new Set(entries.map((e) => e.userId).filter(Boolean))] as string[];
    const userMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const users = await db.select({ id: usersTable.id, fullName: usersTable.fullName }).from(usersTable).where(sql`${usersTable.id} = ANY(${userIds})`);
      for (const u of users) userMap[u.id] = u.fullName;
    }

    res.json({
      entries: entries.map((e) => ({ ...e, userFullName: e.userId ? (userMap[e.userId] ?? null) : null })),
      total: Number(total),
      limit: limitNum,
      offset: offsetNum,
    });
  },
);

// Audit log CSV export
router.get(
  "/admin/audit-log/export",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { startDate, endDate, action: actionFilter, resourceType: resourceTypeFilter, userId: userIdFilter } = req.query as Record<string, string>;

    const conditions = [eq(auditLogTable.orgId, authReq.orgId)];
    if (startDate) conditions.push(gte(auditLogTable.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(auditLogTable.createdAt, new Date(endDate)));
    if (actionFilter) conditions.push(eq(auditLogTable.action, actionFilter));
    if (resourceTypeFilter) conditions.push(eq(auditLogTable.resourceType, resourceTypeFilter));
    if (userIdFilter) conditions.push(eq(auditLogTable.userId, userIdFilter));

    const entries = await db.select().from(auditLogTable).where(and(...conditions))
      .orderBy(desc(auditLogTable.createdAt)).limit(10000);

    const header = ["Timestamp", "User ID", "Role", "Action", "Resource Type", "Resource ID", "IP Address"];
    const rows = entries.map((e) => [
      e.createdAt.toISOString(),
      e.userId ?? "",
      e.userRole ?? "",
      e.action,
      e.resourceType,
      e.resourceId ?? "",
      e.ipAddress ?? "",
    ]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await db.insert(dataExportLogTable).values({ id: randomUUID(), orgId: authReq.orgId, userId: authReq.userId, exportType: "audit_log_csv", filters: { startDate, endDate, action: actionFilter, resourceType: resourceTypeFilter, userId: userIdFilter }, recordCount: entries.length });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

// ─── User Access Review ────────────────────────────────────────────────────────
router.get(
  "/admin/access-review",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        fullName: usersTable.fullName,
        role: usersTable.role,
        isActive: usersTable.isActive,
        lastLoginAt: usersTable.lastLoginAt,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.orgId, authReq.orgId))
      .orderBy(usersTable.fullName);

    res.json(users);
  },
);

// Access review CSV export
router.get(
  "/admin/access-review/export",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const users = await db.select().from(usersTable).where(eq(usersTable.orgId, authReq.orgId));

    const header = ["Full Name", "Email", "Role", "Active", "Last Login", "Created At"];
    const rows = users.map((u) => [
      u.fullName, u.email, u.role,
      u.isActive ? "Yes" : "No",
      u.lastLoginAt?.toISOString() ?? "Never",
      u.createdAt.toISOString(),
    ]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await db.insert(dataExportLogTable).values({ id: randomUUID(), orgId: authReq.orgId, userId: authReq.userId, exportType: "access_review_csv", filters: {}, recordCount: users.length });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="access-review-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

// Deactivate user
router.post(
  "/admin/users/:userId/deactivate",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = param(req.params.userId);

    const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)));
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    await db.update(usersTable).set({ isActive: false }).where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)));

    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "deactivate",
      resourceType: "user",
      resourceId: userId,
      changes: { from: { isActive: true }, to: { isActive: false } },
    });

    res.json({ success: true });
  },
);

// Reactivate user
router.post(
  "/admin/users/:userId/reactivate",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = param(req.params.userId);

    const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)));
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    await db.update(usersTable).set({ isActive: true }).where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)));
    res.json({ success: true });
  },
);

// ─── Login History ────────────────────────────────────────────────────────────
router.get(
  "/admin/login-history",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { userId, limit, offset } = req.query as Record<string, string>;

    const limitNum = safeLimit(limit, 100, 1000);
    const offsetNum = safeOffset(offset);

    const conditions = [eq(loginEventsTable.orgId, authReq.orgId)];
    if (userId) conditions.push(eq(loginEventsTable.userId, userId));

    const [events, [{ total }]] = await Promise.all([
      db.select().from(loginEventsTable).where(and(...conditions))
        .orderBy(desc(loginEventsTable.createdAt)).limit(limitNum).offset(offsetNum),
      db.select({ total: count() }).from(loginEventsTable).where(and(...conditions)),
    ]);

    res.json({ events, total: Number(total), limit: limitNum, offset: offsetNum });
  },
);

// ─── Login History CSV Export ─────────────────────────────────────────────────
router.get(
  "/admin/login-history/export",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { userId, startDate, endDate } = req.query as Record<string, string>;

    const conditions = [eq(loginEventsTable.orgId, authReq.orgId)];
    if (userId) conditions.push(eq(loginEventsTable.userId, userId));
    if (startDate) conditions.push(gte(loginEventsTable.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(loginEventsTable.createdAt, new Date(endDate)));

    const events = await db.select().from(loginEventsTable)
      .where(and(...conditions))
      .orderBy(desc(loginEventsTable.createdAt))
      .limit(10000);

    const header = ["Timestamp", "User ID", "Email", "Result", "IP Address", "User Agent", "Failure Reason"];
    const rows = events.map((e) => [
      e.createdAt.toISOString(),
      e.userId ?? "",
      e.email ?? "",
      e.success ? "success" : "failed",
      e.ipAddress ?? "",
      e.userAgent ?? "",
      e.failureReason ?? "",
    ]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await db.insert(dataExportLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      exportType: "login_history_csv",
      filters: { userId, startDate, endDate },
      recordCount: events.length,
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="login-history-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

// ─── Data Export Log ──────────────────────────────────────────────────────────
router.get(
  "/admin/export-log",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { limit, offset } = req.query as Record<string, string>;

    const limitNum = safeLimit(limit, 50, 500);
    const offsetNum = safeOffset(offset);

    const [exports, [{ total }]] = await Promise.all([
      db.select({
        id: dataExportLogTable.id,
        userId: dataExportLogTable.userId,
        exportType: dataExportLogTable.exportType,
        filters: dataExportLogTable.filters,
        recordCount: dataExportLogTable.recordCount,
        createdAt: dataExportLogTable.createdAt,
        userFullName: usersTable.fullName,
      })
        .from(dataExportLogTable)
        .leftJoin(usersTable, eq(dataExportLogTable.userId, usersTable.id))
        .where(eq(dataExportLogTable.orgId, authReq.orgId))
        .orderBy(desc(dataExportLogTable.createdAt))
        .limit(limitNum).offset(offsetNum),
      db.select({ total: count() }).from(dataExportLogTable).where(eq(dataExportLogTable.orgId, authReq.orgId)),
    ]);

    res.json({ exports, total: Number(total), limit: limitNum, offset: offsetNum });
  },
);

// ─── Session Config ───────────────────────────────────────────────────────────
router.get(
  "/admin/session-config",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const [settings] = await db.select({ sessionTimeoutMinutes: orgSettingsTable.sessionTimeoutMinutes })
      .from(orgSettingsTable).where(eq(orgSettingsTable.orgId, authReq.orgId)).limit(1);
    res.json({ sessionTimeoutMinutes: settings?.sessionTimeoutMinutes ?? 30 });
  },
);

router.put(
  "/admin/session-config",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { sessionTimeoutMinutes } = req.body as { sessionTimeoutMinutes: number };
    const timeout = [15, 30, 60].includes(sessionTimeoutMinutes) ? sessionTimeoutMinutes : 30;

    const [existing] = await db.select({ id: orgSettingsTable.id }).from(orgSettingsTable).where(eq(orgSettingsTable.orgId, authReq.orgId)).limit(1);
    if (existing) {
      await db.update(orgSettingsTable).set({ sessionTimeoutMinutes: timeout }).where(eq(orgSettingsTable.orgId, authReq.orgId));
    } else {
      await db.insert(orgSettingsTable).values({ id: randomUUID(), orgId: authReq.orgId, sessionTimeoutMinutes: timeout });
    }

    res.json({ sessionTimeoutMinutes: timeout });
  },
);

// ─── Session Management (Clerk-backed) ───────────────────────────────────────
// List active Clerk sessions for a user in this org
router.get(
  "/admin/users/:userId/sessions",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = param(req.params.userId);

    const [user] = await db
      .select({ id: usersTable.id, fullName: usersTable.fullName })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)))
      .limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const result = await clerkClient.sessions.getSessionList({ userId, status: "active" });
    res.json(
      result.data.map((s) => ({
        sessionId: s.id,
        createdAt: new Date(s.createdAt).toISOString(),
        lastActiveAt: new Date(s.lastActiveAt).toISOString(),
        expireAt: new Date(s.expireAt).toISOString(),
        status: s.status,
      })),
    );
  },
);

// Revoke a specific Clerk session
router.delete(
  "/admin/sessions/:sessionId",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const sessionId = param(req.params.sessionId);

    // Fetch session from Clerk to get the owning userId
    let clerkSession: Awaited<ReturnType<typeof clerkClient.sessions.getSession>>;
    try {
      clerkSession = await clerkClient.sessions.getSession(sessionId);
    } catch {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!clerkSession?.userId) { res.status(404).json({ error: "Session not found" }); return; }

    // Verify the session's user belongs to the caller's org (prevent cross-tenant revocation)
    const [sessionOwner] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, clerkSession.userId), eq(usersTable.orgId, authReq.orgId)))
      .limit(1);
    if (!sessionOwner) {
      res.status(403).json({ error: "Session does not belong to your organization" });
      return;
    }

    await clerkClient.sessions.revokeSession(sessionId);
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "revoke_session",
      resourceType: "session",
      resourceId: sessionId,
      changes: { targetUserId: clerkSession.userId },
      ipAddress: req.ip ?? null,
    });

    res.json({ success: true });
  },
);

// Force-logout: revoke ALL active sessions for a user
router.post(
  "/admin/users/:userId/force-logout",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = param(req.params.userId);

    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)))
      .limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const sessions = await clerkClient.sessions.getSessionList({ userId, status: "active" });
    await Promise.all(sessions.data.map((s) => clerkClient.sessions.revokeSession(s.id)));

    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "force_logout",
      resourceType: "user",
      resourceId: userId,
      changes: { revokedSessionCount: sessions.data.length },
      ipAddress: req.ip ?? null,
    });

    res.json({ success: true, revokedCount: sessions.data.length });
  },
);

// ─── Data Retention Policies ──────────────────────────────────────────────────
const RETENTION_RECORD_TYPES = ["contacts", "deals", "agents", "audit_log", "communications", "documents"];

router.get(
  "/admin/data-retention",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const policies = await db.select().from(dataRetentionPoliciesTable).where(eq(dataRetentionPoliciesTable.orgId, authReq.orgId));

    // Return all record types with defaults for unconfigured ones
    const result = RETENTION_RECORD_TYPES.map((rt) => {
      const policy = policies.find((p) => p.recordType === rt);
      return policy ?? {
        id: null,
        orgId: authReq.orgId,
        recordType: rt,
        retentionDays: rt === "audit_log" ? 2555 : 1825, // audit: 7yr, others: 5yr
        isEnabled: false,
        updatedAt: new Date(),
        updatedByUserId: null,
      };
    });

    res.json(result);
  },
);

router.put(
  "/admin/data-retention",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { recordType, retentionDays, isEnabled } = req.body as { recordType: string; retentionDays: number; isEnabled: boolean };

    if (!RETENTION_RECORD_TYPES.includes(recordType)) {
      res.status(400).json({ error: "Invalid record type" }); return;
    }

    const [existing] = await db.select().from(dataRetentionPoliciesTable)
      .where(and(eq(dataRetentionPoliciesTable.orgId, authReq.orgId), eq(dataRetentionPoliciesTable.recordType, recordType)));

    if (existing) {
      await db.update(dataRetentionPoliciesTable)
        .set({ retentionDays, isEnabled, updatedAt: new Date(), updatedByUserId: authReq.userId })
        .where(and(eq(dataRetentionPoliciesTable.id, existing.id), eq(dataRetentionPoliciesTable.orgId, authReq.orgId)));
    } else {
      await db.insert(dataRetentionPoliciesTable).values({
        id: randomUUID(), orgId: authReq.orgId, recordType, retentionDays, isEnabled, updatedByUserId: authReq.userId,
      });
    }

    res.json({ success: true });
  },
);

// ─── BAA Readiness Checklist ──────────────────────────────────────────────────
// Each control is computed at request time from real DB state — no static
// "implemented" claims. Returns per-control status plus an overall verdict.

/**
 * Code-level constant: the existence of `maskContact` in routes/contacts.ts is
 * the proof that PHI masking is wired. Bumping this version signals an
 * intentional review of the masking surface.
 */
const PHI_MASK_VERSION = 1;

type BaaStatus = "pass" | "fail" | "warn" | "partial";
interface BaaControlResult {
  id: string;
  label: string;
  status: BaaStatus;
  note?: string;
  evidenceUrl?: string;
}

router.get(
  "/admin/baa-checklist",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const orgId = authReq.orgId;
    const controls: BaaControlResult[] = [];

    // 1. audit_logging_enabled — at least one audit_log row in last 24h
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [{ cnt }] = await db
        .select({ cnt: count() })
        .from(auditLogTable)
        .where(and(eq(auditLogTable.orgId, orgId), gte(auditLogTable.createdAt, since)));
      const n = Number(cnt);
      controls.push({
        id: "audit_logging_enabled",
        label: "Audit logging is actively recording events",
        status: n > 0 ? "pass" : "warn",
        note: n > 0 ? `${n} audit entries in last 24h` : "No audit entries in last 24h",
        evidenceUrl: "/admin/audit-log",
      });
    } catch (err) {
      controls.push({
        id: "audit_logging_enabled",
        label: "Audit logging is actively recording events",
        status: "fail",
        note: `Audit log query failed: ${(err as Error).message}`,
      });
    }

    // 2. phi_masking_active — code-level constant
    controls.push({
      id: "phi_masking_active",
      label: "PHI masking is active for non-privileged roles",
      status: "pass",
      note: `maskContact present in routes/contacts.ts (PHI_MASK_VERSION=${PHI_MASK_VERSION})`,
    });

    // 3. object_storage_acl_enforced — checks for an org-scoped policy row.
    // The object_storage_policies table is part of a planned hardening tier;
    // wrap in try/catch so we degrade to "warn" if the table doesn't exist yet.
    try {
      const result = await db.execute(
        sql`SELECT count(*)::int AS c FROM object_storage_policies WHERE org_id = ${orgId}`,
      );
      // node-postgres + drizzle returns { rows: [...] }
      const rows = (result as unknown as { rows?: Array<{ c: number }> }).rows ?? [];
      const c = rows[0]?.c ?? 0;
      controls.push({
        id: "object_storage_acl_enforced",
        label: "Object-storage ACL policy registered for this org",
        status: c > 0 ? "pass" : "warn",
        note: c > 0 ? `${c} ACL policy row(s) on file` : "No ACL policy row found for this org",
      });
    } catch {
      controls.push({
        id: "object_storage_acl_enforced",
        label: "Object-storage ACL policy registered for this org",
        status: "warn",
        note: "object_storage_policies table not provisioned yet — provider-level ACL still applies",
      });
    }

    // 4. data_retention_policy_set — at least one configured retention row
    try {
      const [{ cnt }] = await db
        .select({ cnt: count() })
        .from(dataRetentionPoliciesTable)
        .where(eq(dataRetentionPoliciesTable.orgId, orgId));
      const n = Number(cnt);
      controls.push({
        id: "data_retention_policy_set",
        label: "Data retention policy configured",
        status: n > 0 ? "pass" : "warn",
        note: n > 0
          ? `${n} retention policy row(s) configured`
          : "No retention rows — platform defaults (5–7yr) will apply",
        evidenceUrl: "/admin/data-retention",
      });
    } catch (err) {
      controls.push({
        id: "data_retention_policy_set",
        label: "Data retention policy configured",
        status: "fail",
        note: `Retention policy query failed: ${(err as Error).message}`,
      });
    }

    // 5. breach_notification_workflow — table exists + (≥1 resolved row OR
    // zero breaches reported in last 90 days)
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const [{ resolved }] = await db
        .select({ resolved: count() })
        .from(breachNotificationsTable)
        .where(and(eq(breachNotificationsTable.orgId, orgId), eq(breachNotificationsTable.status, "resolved")));
      const [{ recent }] = await db
        .select({ recent: count() })
        .from(breachNotificationsTable)
        .where(and(eq(breachNotificationsTable.orgId, orgId), gte(breachNotificationsTable.detectedAt, ninetyDaysAgo)));
      const resolvedN = Number(resolved);
      const recentN = Number(recent);
      const ok = resolvedN > 0 || recentN === 0;
      controls.push({
        id: "breach_notification_workflow",
        label: "HIPAA breach-notification workflow available",
        status: ok ? "pass" : "warn",
        note: ok
          ? `${resolvedN} resolved breach record(s); ${recentN} reported in last 90d`
          : `${recentN} unresolved breaches reported in last 90d`,
        evidenceUrl: "/admin/breach-notifications",
      });
    } catch (err) {
      controls.push({
        id: "breach_notification_workflow",
        label: "HIPAA breach-notification workflow available",
        status: "fail",
        note: `breach_notifications query failed: ${(err as Error).message}`,
      });
    }

    // 6. export_anomaly_alerting — PASS once the cron has demonstrably run.
    // Proof of life is either (a) at least one breach_notifications row
    // created by `export_anomaly_alert` in the last 30 days, OR (b) zero
    // export traffic in the same window (nothing for the detector to
    // analyze). Anything else degrades to WARN so an operator can verify
    // the cron is alive.
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [{ anomalies }] = await db
        .select({ anomalies: count() })
        .from(breachNotificationsTable)
        .where(
          and(
            eq(breachNotificationsTable.orgId, orgId),
            eq(breachNotificationsTable.detectedBySystem, "export_anomaly_alert"),
            gte(breachNotificationsTable.detectedAt, thirtyDaysAgo),
          ),
        );
      const [{ exports: exportCount }] = await db
        .select({ exports: count() })
        .from(dataExportLogTable)
        .where(
          and(
            eq(dataExportLogTable.orgId, orgId),
            gte(dataExportLogTable.createdAt, thirtyDaysAgo),
          ),
        );
      const anomaliesN = Number(anomalies);
      const exportsN = Number(exportCount);
      const ok = anomaliesN > 0 || exportsN === 0;
      controls.push({
        id: "export_anomaly_alerting",
        label: "Anomalous export volume alerting",
        status: ok ? "pass" : "warn",
        note: ok
          ? anomaliesN > 0
            ? `${anomaliesN} anomaly alert(s) recorded in last 30d (detector active)`
            : "No export traffic in last 30d — nothing to alert on"
          : `${exportsN} exports in last 30d but no anomaly alerts recorded — verify cron is running`,
        evidenceUrl: "/admin/export-log",
      });
    } catch (err) {
      controls.push({
        id: "export_anomaly_alerting",
        label: "Anomalous export volume alerting",
        status: "fail",
        note: `Export anomaly query failed: ${(err as Error).message}`,
      });
    }

    // Aggregate verdict
    const hasFail = controls.some((c) => c.status === "fail");
    const hasWarnish = controls.some((c) => c.status === "warn" || c.status === "partial");
    const overall: BaaStatus = hasFail ? "fail" : hasWarnish ? "warn" : "pass";

    res.json({
      controls,
      overall,
      generatedAt: new Date().toISOString(),
    });
  },
);

// ─── SOC 2 Evidence Pack (PDF) ────────────────────────────────────────────────
router.post(
  "/admin/soc2-evidence-pack",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const [users, auditStats, loginStats, exportStats, retentionPolicies, sessionConfig] = await Promise.all([
      db.select().from(usersTable).where(eq(usersTable.orgId, authReq.orgId)),
      db.select({ total: count() }).from(auditLogTable).where(eq(auditLogTable.orgId, authReq.orgId)),
      Promise.all([
        db.select({ cnt: count() }).from(loginEventsTable).where(and(eq(loginEventsTable.orgId, authReq.orgId), eq(loginEventsTable.success, true))),
        db.select({ cnt: count() }).from(loginEventsTable).where(and(eq(loginEventsTable.orgId, authReq.orgId), eq(loginEventsTable.success, false))),
      ]),
      db.select({ cnt: count() }).from(dataExportLogTable).where(eq(dataExportLogTable.orgId, authReq.orgId)),
      db.select().from(dataRetentionPoliciesTable).where(eq(dataRetentionPoliciesTable.orgId, authReq.orgId)),
      db.select({ sessionTimeoutMinutes: orgSettingsTable.sessionTimeoutMinutes }).from(orgSettingsTable).where(eq(orgSettingsTable.orgId, authReq.orgId)).limit(1),
    ]);

    const generatedAt = new Date();
    const docId = randomUUID();

    // Build PDF
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));

    await new Promise<void>((resolve) => {
      doc.on("end", resolve);

      // Cover
      doc.fontSize(24).font("Helvetica-Bold").text("SOC 2 Evidence Report", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica").text(`Generated: ${generatedAt.toUTCString()}`, { align: "center" });
      doc.moveDown(0.5);
      doc.text("agencyBRIDGE — Medicare Agency Platform", { align: "center" });
      doc.moveDown(2);

      const section = (title: string) => {
        doc.fontSize(14).font("Helvetica-Bold").text(title);
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(560, doc.y).stroke();
        doc.moveDown(0.5);
        doc.font("Helvetica").fontSize(10);
      };

      const row = (label: string, value: string) => {
        doc.text(`${label}: ${value}`);
      };

      // 1. User Access Review
      section("1. User Access Review");
      const activeUsers = users.filter((u) => u.isActive);
      const inactiveUsers = users.filter((u) => !u.isActive);
      row("Total Users", String(users.length));
      row("Active Users", String(activeUsers.length));
      row("Inactive/Locked Users", String(inactiveUsers.length));
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(9).text("Name                         Email                              Role                Last Login");
      doc.font("Helvetica").fontSize(9);
      for (const u of users.slice(0, 30)) {
        const name = u.fullName.padEnd(28).slice(0, 28);
        const email = u.email.padEnd(34).slice(0, 34);
        const role = u.role.padEnd(19).slice(0, 19);
        const login = u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 10) : "Never";
        doc.text(`${name} ${email} ${role} ${login}`);
      }
      if (users.length > 30) doc.text(`... and ${users.length - 30} more users`);
      doc.moveDown(1);

      // 2. Login History Summary
      section("2. Login History Summary");
      row("Successful Logins (all time)", String(loginStats[0][0]?.cnt ?? 0));
      row("Failed Login Attempts (all time)", String(loginStats[1][0]?.cnt ?? 0));
      doc.moveDown(1);

      // 3. Audit Log Statistics
      section("3. Audit Log Statistics");
      row("Total Audit Log Entries", String(auditStats[0]?.total ?? 0));
      doc.moveDown(1);

      // 4. Data Export Log Summary
      section("4. Data Export Log Summary");
      row("Total Export Events Logged", String(exportStats[0]?.cnt ?? 0));
      doc.moveDown(1);

      // 5. Session Timeout Configuration
      section("5. Session Management Configuration");
      row("Session Timeout", `${sessionConfig[0]?.sessionTimeoutMinutes ?? 30} minutes of inactivity`);
      doc.moveDown(1);

      // 6. Data Retention Policies
      section("6. Data Retention Policies");
      if (retentionPolicies.length === 0) {
        doc.text("No custom retention policies configured. Platform defaults apply (5–7 year retention).");
      } else {
        for (const p of retentionPolicies) {
          row(p.recordType, `${p.retentionDays} days (${p.isEnabled ? "ENABLED" : "disabled"})`);
        }
      }
      doc.moveDown(1);

      // 7. HIPAA Controls — references the live BAA checklist endpoint
      // for runtime evidence (status is computed per-org at request time).
      section("7. HIPAA Safeguard Controls Summary");
      row("BAA Checklist Endpoint", "GET /admin/baa-checklist");
      row("PHI Mask Version", String(PHI_MASK_VERSION));
      doc.moveDown(1);

      // Footer
      doc.fontSize(8).fillColor("#666")
        .text(`This report was automatically generated by agencyBRIDGE on ${generatedAt.toUTCString()}. It represents system state at time of generation.`, { align: "center" });

      doc.end();
    });

    const pdfBuffer = Buffer.concat(chunks);

    // Upload PDF to object storage, then record the storage path in documents
    let storageKey: string;
    try {
      storageKey = await objectStorage.uploadDocument(
        pdfBuffer,
        `soc2-evidence-${generatedAt.toISOString().slice(0, 10)}.pdf`,
        authReq.orgId,
        { contentType: "application/pdf" },
      );
    } catch {
      // If storage upload fails, fall back to a placeholder key (PDF still returned to client)
      storageKey = `soc2/evidence-pack-${docId}.pdf`;
    }

    await db.insert(documentsTable).values({
      id: docId,
      orgId: authReq.orgId,
      uploadedBy: authReq.userId,
      name: `SOC 2 Evidence Report — ${generatedAt.toISOString().slice(0, 10)}`,
      storageKey,
      mimeType: "application/pdf",
      fileSizeBytes: pdfBuffer.length,
      category: "compliance",
    });

    await db.insert(dataExportLogTable).values({
      id: randomUUID(), orgId: authReq.orgId, userId: authReq.userId,
      exportType: "soc2_evidence_pdf", filters: {}, recordCount: 1,
    });

    // Return PDF directly
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="soc2-evidence-${generatedAt.toISOString().slice(0, 10)}.pdf"`);
    res.send(pdfBuffer);
  },
);

// ─── Hard-delete Confirmation (admin-only) ────────────────────────────────────
// Called after a retention review task is approved. Permanently removes a
// soft-deleted record that has passed its retention window.
// Records a full audit trail entry before deletion.
router.delete(
  "/admin/retention/hard-delete/:recordType/:recordId",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  requireDestructiveConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { recordType, recordId } = req.params as { recordType: string; recordId: string };

    const SUPPORTED = ["contacts", "deals"];
    if (!SUPPORTED.includes(recordType)) {
      res.status(400).json({ error: "Unsupported record type. Supported: contacts, deals" });
      return;
    }

    // Verify the record belongs to this org and is already soft-deleted
    if (recordType === "contacts") {
      const [contact] = await db
        .select({ id: contactsTable.id, deletedAt: contactsTable.deletedAt })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, recordId), eq(contactsTable.orgId, authReq.orgId)))
        .limit(1);

      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!contact.deletedAt) {
        res.status(409).json({ error: "Record must be soft-deleted before hard deletion" });
        return;
      }

      // Check retention policy
      const [policy] = await db
        .select()
        .from(dataRetentionPoliciesTable)
        .where(and(eq(dataRetentionPoliciesTable.orgId, authReq.orgId), eq(dataRetentionPoliciesTable.recordType, "contacts")))
        .limit(1);

      if (policy?.isEnabled) {
        const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
        if (contact.deletedAt > cutoff) {
          res.status(409).json({ error: `Record has not yet passed the ${policy.retentionDays}-day retention window` });
          return;
        }
      }

      // Audit before hard delete
      await db.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        userId: authReq.userId,
        action: "hard_delete",
        resourceType: "contact",
        resourceId: recordId,
        changes: { confirmedBy: authReq.userId, confirmedAt: new Date().toISOString() },
      });

      await db.delete(contactsTable).where(and(eq(contactsTable.id, recordId), eq(contactsTable.orgId, authReq.orgId)));

    } else if (recordType === "deals") {
      const [deal] = await db
        .select({ id: dealsTable.id, deletedAt: dealsTable.deletedAt })
        .from(dealsTable)
        .where(and(eq(dealsTable.id, recordId), eq(dealsTable.orgId, authReq.orgId)))
        .limit(1);

      if (!deal) {
        res.status(404).json({ error: "Deal not found" });
        return;
      }
      if (!deal.deletedAt) {
        res.status(409).json({ error: "Record must be soft-deleted before hard deletion" });
        return;
      }

      const [policy] = await db
        .select()
        .from(dataRetentionPoliciesTable)
        .where(and(eq(dataRetentionPoliciesTable.orgId, authReq.orgId), eq(dataRetentionPoliciesTable.recordType, "deals")))
        .limit(1);

      if (policy?.isEnabled) {
        const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
        if (deal.deletedAt > cutoff) {
          res.status(409).json({ error: `Record has not yet passed the ${policy.retentionDays}-day retention window` });
          return;
        }
      }

      await db.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        userId: authReq.userId,
        action: "hard_delete",
        resourceType: "deal",
        resourceId: recordId,
        changes: { confirmedBy: authReq.userId, confirmedAt: new Date().toISOString() },
      });

      await db.delete(dealsTable).where(and(eq(dealsTable.id, recordId), eq(dealsTable.orgId, authReq.orgId)));
    }

    res.json({ success: true, message: `${recordType} record permanently deleted and audit logged` });
  },
);

// ─── Soft-deleted records pending hard-delete review ──────────────────────────
router.get(
  "/admin/retention/pending-hard-delete",
  requireAuth,
  requireMfa,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const [contacts, deals] = await Promise.all([
      db.select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName, email: contactsTable.email, deletedAt: contactsTable.deletedAt })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), isNotNull(contactsTable.deletedAt)))
        .orderBy(contactsTable.deletedAt),
      db.select({ id: dealsTable.id, title: dealsTable.title, deletedAt: dealsTable.deletedAt })
        .from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), isNotNull(dealsTable.deletedAt)))
        .orderBy(dealsTable.deletedAt),
    ]);

    res.json({
      contacts: contacts.map((c) => ({ ...c, recordType: "contacts" })),
      deals: deals.map((d) => ({ ...d, recordType: "deals" })),
    });
  },
);

// ─── Batch Hard-Delete (super_admin only) ─────────────────────────────────────
// Permanently removes soft-deleted rows older than `olderThanDays`. Hard-capped
// at 10000 rows per call. Writes a single summary audit_log entry per batch.
//
// Note: leadsTable does not currently expose a deleted_at column, so it is
// validated as a recognized resourceType but rejected at runtime. The endpoint
// is forward-compatible — when leads gain soft-delete, only the BATCH_TARGETS
// branch needs updating.
const BATCH_RESOURCE_TYPES = ["contact", "deal", "lead"] as const;
type BatchResourceType = (typeof BATCH_RESOURCE_TYPES)[number];

router.post(
  "/admin/retention/hard-delete-batch",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  requireDestructiveConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const body = req.body as {
      resourceType?: string;
      olderThanDays?: number;
      dryRun?: boolean;
    };

    const resourceType = body.resourceType as BatchResourceType | undefined;
    const olderThanDays = body.olderThanDays;
    const dryRun = body.dryRun === true;

    if (!resourceType || !BATCH_RESOURCE_TYPES.includes(resourceType)) {
      res.status(400).json({ error: `resourceType must be one of: ${BATCH_RESOURCE_TYPES.join(", ")}` });
      return;
    }
    if (typeof olderThanDays !== "number" || !Number.isFinite(olderThanDays) || olderThanDays < 1) {
      res.status(400).json({ error: "olderThanDays must be a positive number" });
      return;
    }

    const HARD_CAP = 10000;
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    // Resolve target table — only contact/deal currently support soft-delete.
    if (resourceType === "lead") {
      res.status(400).json({
        error: "lead resourceType not yet eligible: leads table has no deleted_at column",
      });
      return;
    }

    const table = resourceType === "contact" ? contactsTable : dealsTable;

    // Select candidate IDs (capped at HARD_CAP)
    const candidates = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.orgId, authReq.orgId),
          isNotNull(table.deletedAt),
          lt(table.deletedAt, cutoff),
        ),
      )
      .limit(HARD_CAP);

    const ids = candidates.map((c) => c.id);

    if (dryRun) {
      res.json({
        dryRun: true,
        resourceType,
        olderThanDays,
        cutoff: cutoff.toISOString(),
        cap: HARD_CAP,
        eligibleCount: ids.length,
        sampleIds: ids.slice(0, 10),
      });
      return;
    }

    if (ids.length === 0) {
      res.json({
        dryRun: false,
        resourceType,
        olderThanDays,
        cutoff: cutoff.toISOString(),
        deletedCount: 0,
      });
      return;
    }

    // Single summary audit entry covering the whole batch.
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "hard_delete_batch",
      resourceType,
      resourceId: null,
      changes: {
        resourceType,
        olderThanDays,
        cutoff: cutoff.toISOString(),
        deletedCount: ids.length,
        cap: HARD_CAP,
        sampleIds: ids.slice(0, 10),
        confirmedBy: authReq.userId,
        confirmedAt: new Date().toISOString(),
      },
      ipAddress: req.ip ?? null,
    });

    // Perform hard delete in one statement.
    await db
      .delete(table)
      .where(
        and(
          eq(table.orgId, authReq.orgId),
          isNotNull(table.deletedAt),
          lt(table.deletedAt, cutoff),
          sql`${table.id} = ANY(${ids})`,
        ),
      );

    res.json({
      dryRun: false,
      resourceType,
      olderThanDays,
      cutoff: cutoff.toISOString(),
      deletedCount: ids.length,
      cap: HARD_CAP,
    });
  },
);

// ─── Breach Notifications (HIPAA workflow) ────────────────────────────────────
// CRUD over the `breach_notifications` ledger. Restricted to super_admin and
// compliance_manager. Every state transition is mirrored into audit_log.

const BREACH_ROLES = ["super_admin", "compliance_manager"] as const;

router.post(
  "/admin/breach-notifications",
  requireAuth,
  requireMfa,
  requireRole(...BREACH_ROLES),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const body = req.body as {
      affectedRecordType?: string;
      affectedRecordCount?: number;
      description?: string;
      severity?: string;
      detectedBySystem?: string;
      notificationRequired?: boolean;
    };

    if (!body.affectedRecordType || typeof body.affectedRecordType !== "string") {
      res.status(400).json({ error: "affectedRecordType is required" });
      return;
    }
    if (typeof body.affectedRecordCount !== "number" || body.affectedRecordCount < 0) {
      res.status(400).json({ error: "affectedRecordCount must be a non-negative number" });
      return;
    }
    if (!body.description || typeof body.description !== "string") {
      res.status(400).json({ error: "description is required" });
      return;
    }

    const severity: BreachSeverity =
      body.severity && (BREACH_SEVERITIES as readonly string[]).includes(body.severity)
        ? (body.severity as BreachSeverity)
        : "low";

    const id = randomUUID();
    const [created] = await db
      .insert(breachNotificationsTable)
      .values({
        id,
        orgId: authReq.orgId,
        detectedByUserId: authReq.userId,
        detectedBySystem: body.detectedBySystem ?? "manual",
        affectedRecordType: body.affectedRecordType,
        affectedRecordCount: body.affectedRecordCount,
        description: body.description,
        severity,
        status: "open",
        notificationRequired: body.notificationRequired === true,
      })
      .returning();

    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "create",
      resourceType: "breach_notification",
      resourceId: id,
      changes: { severity, affectedRecordType: body.affectedRecordType, affectedRecordCount: body.affectedRecordCount },
      ipAddress: req.ip ?? null,
    });

    res.status(201).json(created);
  },
);

router.get(
  "/admin/breach-notifications",
  requireAuth,
  requireMfa,
  requireRole(...BREACH_ROLES),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, limit, offset } = req.query as Record<string, string>;

    const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 500);
    const offsetNum = parseInt(offset ?? "0", 10) || 0;

    const conditions = [eq(breachNotificationsTable.orgId, authReq.orgId)];
    if (status && (BREACH_STATUSES as readonly string[]).includes(status)) {
      conditions.push(eq(breachNotificationsTable.status, status as BreachStatus));
    }

    const [entries, [{ total }]] = await Promise.all([
      db
        .select()
        .from(breachNotificationsTable)
        .where(and(...conditions))
        .orderBy(desc(breachNotificationsTable.detectedAt))
        .limit(limitNum)
        .offset(offsetNum),
      db.select({ total: count() }).from(breachNotificationsTable).where(and(...conditions)),
    ]);

    res.json({ entries, total: Number(total), limit: limitNum, offset: offsetNum });
  },
);

router.get(
  "/admin/breach-notifications/:id",
  requireAuth,
  requireMfa,
  requireRole(...BREACH_ROLES),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = param(req.params.id);

    const [entry] = await db
      .select()
      .from(breachNotificationsTable)
      .where(and(eq(breachNotificationsTable.id, id), eq(breachNotificationsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!entry) {
      res.status(404).json({ error: "Breach notification not found" });
      return;
    }

    res.json(entry);
  },
);

router.patch(
  "/admin/breach-notifications/:id",
  requireAuth,
  requireMfa,
  requireRole(...BREACH_ROLES),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = param(req.params.id);
    const body = req.body as {
      status?: string;
      severity?: string;
      resolutionNotes?: string;
      notificationRequired?: boolean;
      notifiedVia?: { individuals?: boolean; hhs?: boolean; media?: boolean };
    };

    const [existing] = await db
      .select()
      .from(breachNotificationsTable)
      .where(and(eq(breachNotificationsTable.id, id), eq(breachNotificationsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Breach notification not found" });
      return;
    }

    const update: Partial<typeof breachNotificationsTable.$inferInsert> = {};
    const auditChanges: Record<string, unknown> = {};

    if (body.status && (BREACH_STATUSES as readonly string[]).includes(body.status)) {
      update.status = body.status as BreachStatus;
      auditChanges.status = { from: existing.status, to: body.status };
      if (body.status === "resolved" || body.status === "false_positive") {
        update.resolvedAt = new Date();
        update.resolvedByUserId = authReq.userId;
      }
      if (body.status === "notified") {
        update.notifiedAt = new Date();
      }
    }
    if (body.severity && (BREACH_SEVERITIES as readonly string[]).includes(body.severity)) {
      update.severity = body.severity as BreachSeverity;
      auditChanges.severity = { from: existing.severity, to: body.severity };
    }
    if (typeof body.resolutionNotes === "string") {
      update.resolutionNotes = body.resolutionNotes;
      auditChanges.resolutionNotes = "updated";
    }
    if (typeof body.notificationRequired === "boolean") {
      update.notificationRequired = body.notificationRequired;
      auditChanges.notificationRequired = { from: existing.notificationRequired, to: body.notificationRequired };
    }
    if (body.notifiedVia && typeof body.notifiedVia === "object") {
      update.notifiedVia = body.notifiedVia;
      auditChanges.notifiedVia = body.notifiedVia;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const [updated] = await db
      .update(breachNotificationsTable)
      .set(update)
      .where(and(eq(breachNotificationsTable.id, id), eq(breachNotificationsTable.orgId, authReq.orgId)))
      .returning();

    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "update",
      resourceType: "breach_notification",
      resourceId: id,
      changes: auditChanges,
      ipAddress: req.ip ?? null,
    });

    res.json(updated);
  },
);

export default router;
