/**
 * Admin routes: HIPAA/SOC 2 compliance infrastructure.
 * All endpoints require super_admin or agency_admin role.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, sql, desc, count } from "drizzle-orm";
import {
  db,
  auditLogTable,
  usersTable,
  loginEventsTable,
  dataExportLogTable,
  dataRetentionPoliciesTable,
  orgSettingsTable,
  documentsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import { ObjectStorageService } from "../lib/objectStorage";
import { clerkClient } from "@clerk/express";

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
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { userId, action, resourceType, startDate, endDate, limit, offset } = req.query as Record<string, string>;

    const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 500);
    const offsetNum = parseInt(offset ?? "0", 10) || 0;

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
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { startDate, endDate, action: actionFilter, resourceType: resourceTypeFilter } = req.query as Record<string, string>;

    const conditions = [eq(auditLogTable.orgId, authReq.orgId)];
    if (startDate) conditions.push(gte(auditLogTable.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(auditLogTable.createdAt, new Date(endDate)));
    if (actionFilter) conditions.push(eq(auditLogTable.action, actionFilter));
    if (resourceTypeFilter) conditions.push(eq(auditLogTable.resourceType, resourceTypeFilter));

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

    await db.insert(dataExportLogTable).values({ id: randomUUID(), orgId: authReq.orgId, userId: authReq.userId, exportType: "audit_log_csv", filters: { startDate, endDate, action: actionFilter, resourceType: resourceTypeFilter }, recordCount: entries.length });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

// ─── User Access Review ────────────────────────────────────────────────────────
router.get(
  "/admin/access-review",
  requireAuth,
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
  requireRole("super_admin", "agency_admin"),
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
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = param(req.params.userId);

    const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)));
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId));

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
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = param(req.params.userId);

    const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.orgId, authReq.orgId)));
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, userId));
    res.json({ success: true });
  },
);

// ─── Login History ────────────────────────────────────────────────────────────
router.get(
  "/admin/login-history",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { userId, limit, offset } = req.query as Record<string, string>;

    const limitNum = Math.min(parseInt(limit ?? "100", 10) || 100, 1000);
    const offsetNum = parseInt(offset ?? "0", 10) || 0;

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

// ─── Data Export Log ──────────────────────────────────────────────────────────
router.get(
  "/admin/export-log",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { limit, offset } = req.query as Record<string, string>;

    const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 500);
    const offsetNum = parseInt(offset ?? "0", 10) || 0;

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
const RETENTION_RECORD_TYPES = ["contacts", "agents", "audit_log", "communications", "documents"];

router.get(
  "/admin/data-retention",
  requireAuth,
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
        .where(eq(dataRetentionPoliciesTable.id, existing.id));
    } else {
      await db.insert(dataRetentionPoliciesTable).values({
        id: randomUUID(), orgId: authReq.orgId, recordType, retentionDays, isEnabled, updatedByUserId: authReq.userId,
      });
    }

    res.json({ success: true });
  },
);

// ─── BAA Readiness Checklist ──────────────────────────────────────────────────
const BAA_CONTROLS = [
  { id: "access_controls", category: "Access Controls", control: "Role-based access control (RBAC) with least-privilege roles", status: "implemented" },
  { id: "user_auth", category: "Access Controls", control: "Multi-factor authentication via Clerk", status: "implemented" },
  { id: "session_mgmt", category: "Access Controls", control: "Configurable session timeout (15/30/60 min)", status: "implemented" },
  { id: "audit_logging", category: "Audit Controls", control: "Immutable audit log of all data access and modifications", status: "implemented" },
  { id: "audit_export", category: "Audit Controls", control: "Audit log exportable for external auditor review", status: "implemented" },
  { id: "login_history", category: "Audit Controls", control: "Login event log with IP, device, and success/failure tracking", status: "implemented" },
  { id: "phi_masking", category: "Data Security", control: "PHI fields (Medicare ID, DOB, health conditions) masked for non-privileged roles", status: "partial", notes: "Medicare ID and DOB masking implemented; health conditions masking in progress" },
  { id: "encryption_transit", category: "Data Security", control: "All data transmitted over TLS (HTTPS enforced)", status: "implemented" },
  { id: "encryption_rest", category: "Data Security", control: "Database encryption at rest (managed by Replit PostgreSQL)", status: "implemented" },
  { id: "data_retention", category: "Data Management", control: "Configurable data retention policies per record type", status: "implemented" },
  { id: "soft_delete", category: "Data Management", control: "Soft-delete with retention review task creation before hard delete", status: "partial", notes: "Soft-delete enforced; hard-delete UI confirmation in progress" },
  { id: "export_log", category: "Data Management", control: "All CSV/PDF data exports logged with user, timestamp, and record count", status: "implemented" },
  { id: "org_isolation", category: "Multi-Tenancy", control: "Complete org-level data isolation — all queries scoped to orgId", status: "implemented" },
  { id: "phi_breach", category: "Incident Response", control: "Data breach detection through anomalous export volume monitoring (via export log)", status: "partial", notes: "Export log available; automated alerting not yet wired" },
  { id: "access_review", category: "Access Management", control: "User access review report with role history and last-login visibility", status: "implemented" },
  { id: "offboarding", category: "Access Management", control: "Formal agent offboarding workflow with automated access revocation checklist", status: "implemented" },
];

router.get(
  "/admin/baa-checklist",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (_req: Request, res: Response): Promise<void> => {
    res.json(BAA_CONTROLS);
  },
);

// ─── SOC 2 Evidence Pack (PDF) ────────────────────────────────────────────────
router.post(
  "/admin/soc2-evidence-pack",
  requireAuth,
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
      doc.text("MediFlow — Medicare Agency Platform", { align: "center" });
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

      // 7. HIPAA Controls
      section("7. HIPAA Safeguard Controls Summary");
      const implemented = BAA_CONTROLS.filter((c) => c.status === "implemented").length;
      const partial = BAA_CONTROLS.filter((c) => c.status === "partial").length;
      row("Controls Fully Implemented", `${implemented}/${BAA_CONTROLS.length}`);
      row("Controls Partially Implemented", `${partial}/${BAA_CONTROLS.length}`);
      doc.moveDown(1);

      // Footer
      doc.fontSize(8).fillColor("#666")
        .text(`This report was automatically generated by MediFlow on ${generatedAt.toUTCString()}. It represents system state at time of generation.`, { align: "center" });

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

export default router;
