import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, ilike, or, desc, inArray, type SQL } from "drizzle-orm";
import {
  db,
  agentsTable,
  usersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  checklistRunsTable,
  checklistItemsTable,
  documentsTable,
  type Agent,
} from "@workspace/db";
import { z } from "zod";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { enforceCapacity } from "../middlewares/requirePlan";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import { randomUUID } from "crypto";
import { createChecklistRun } from "./checklists";
import { safeLimit, safeOffset } from "../lib/listGuards";

const InitialLicenseSchema = z.object({
  stateCode: z.string().length(2).toUpperCase(),
  licenseType: z.string().min(1).max(100),
  licenseNumber: z.string().max(50).optional(),
  status: z.enum(["active", "pending", "expired", "suspended", "not_appointed"]).default("pending"),
});

const CreateAgentSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  npn: z.string().max(20).optional(),
  hireDate: z.string().optional(),
  managerId: z.string().optional(),
  notes: z.string().max(5000).optional(),
  checklistTemplateId: z.string().optional(),
  initialLicense: InitialLicenseSchema.optional(),
});

const UpdateAgentSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).nullable().optional(),
  npn: z.string().max(20).nullable().optional(),
  status: z
    .enum(["onboarding", "active", "suspended", "offboarding", "offboarded"])
    .optional(),
  hireDate: z.string().nullable().optional(),
  offboardDate: z.string().nullable().optional(),
  managerId: z.string().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

type AgentStatus = "onboarding" | "active" | "suspended" | "offboarding" | "offboarded";
const VALID_AGENT_STATUSES: AgentStatus[] = [
  "onboarding",
  "active",
  "suspended",
  "offboarding",
  "offboarded",
];

function isAgentStatus(value: string): value is AgentStatus {
  return (VALID_AGENT_STATUSES as string[]).includes(value);
}

const router: IRouter = Router();

router.use(
  routerAuditMiddleware(router, "agent", undefined, {
    includeReads: true,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

router.get(
  "/agents",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, managerId, search, limit, offset, sortBy, sortDir } = req.query as {
      status?: string;
      managerId?: string;
      search?: string;
      limit?: string;
      offset?: string;
      sortBy?: string;
      sortDir?: string;
    };

    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);

    const conditions: SQL[] = [eq(agentsTable.orgId, authReq.orgId)];

    if (status && isAgentStatus(status)) {
      conditions.push(eq(agentsTable.status, status));
    }
    if (managerId) {
      conditions.push(eq(agentsTable.managerId, managerId));
    }
    if (search) {
      const searchExpr = or(
        ilike(agentsTable.firstName, `%${search}%`),
        ilike(agentsTable.lastName, `%${search}%`),
        ilike(agentsTable.email, `%${search}%`),
      );
      if (searchExpr) conditions.push(searchExpr);
    }

    const dir = sortDir === "desc" ? "DESC" : "ASC";
    // Compliance score formula (max 100):
    //   Licensing    40 pts — proportional: active_licenses / total_licenses
    //   Certifications 30 pts — proportional: passed_certs / total_certs
    //   AHIP         20 pts — binary: passed in current year = 20, else 0
    //   Onboarding   10 pts — proportional: completed+skipped items / total items
    // Proportional scoring chosen over binary for onboarding so partial progress
    // is visible on the roster and agents aren't stuck at 0 until the last step.
    const complianceScoreSql = sql`(
      COALESCE((SELECT CAST(count(*) FILTER (WHERE status = 'active') AS FLOAT) / NULLIF(count(*), 0) FROM state_licenses WHERE agent_id = agents.id), 0) * 40 +
      COALESCE((SELECT CAST(count(*) FILTER (WHERE status = 'passed') AS FLOAT) / NULLIF(count(*), 0) FROM carrier_certifications WHERE agent_id = agents.id), 0) * 30 +
      CASE WHEN EXISTS (SELECT 1 FROM ahip_records WHERE agent_id = agents.id AND status = 'passed' AND certification_year = EXTRACT(YEAR FROM NOW())::int) THEN 20 ELSE 0 END +
      COALESCE((SELECT CAST(count(*) FILTER (WHERE ci.status IN ('completed', 'skipped')) AS FLOAT) / NULLIF(count(*), 0) FROM checklist_runs cr JOIN checklist_items ci ON cr.id = ci.run_id WHERE cr.agent_id = agents.id AND cr.type = 'onboarding'), 0) * 10
    )`;

    const orderExpr =
      sortBy === "complianceScore" ? sql`${complianceScoreSql} ${sql.raw(dir)}` :
      sortBy === "status" ? sql`${agentsTable.status} ${sql.raw(dir)}` :
      sortBy === "hireDate" ? sql`${agentsTable.hireDate} ${sql.raw(dir)} NULLS LAST` :
      sortBy === "email" ? sql`${agentsTable.email} ${sql.raw(dir)}` :
      sql`${agentsTable.lastName} ${sql.raw(dir)}, ${agentsTable.firstName} ${sql.raw(dir)}`;

    const [allAgents, totalResult] = await Promise.all([
      db
        .select()
        .from(agentsTable)
        .where(and(...conditions))
        .orderBy(orderExpr)
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(agentsTable)
        .where(and(...conditions)),
    ]);

    const agentIds = allAgents.map((a) => a.id);
    const licCounts =
      agentIds.length > 0
        ? await db
            .select({
              agentId: stateLicensesTable.agentId,
              count: sql<number>`count(*)::int`,
            })
            .from(stateLicensesTable)
            .where(
              and(
                inArray(stateLicensesTable.agentId, agentIds),
                eq(stateLicensesTable.status, "active"),
              ),
            )
            .groupBy(stateLicensesTable.agentId)
        : [];
    const licCountMap = new Map(licCounts.map((r) => [r.agentId, r.count]));
    const agentsWithCounts = allAgents.map((a) => ({
      ...a,
      activeLicenseCount: licCountMap.get(a.id) ?? 0,
    }));

    res.json({
      agents: agentsWithCounts,
      total: Number(totalResult[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
  },
);

router.post(
  "/agents",
  requireAuth,
  requirePermission("agent", "create"),
  enforceCapacity("agents"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { firstName, lastName, email, phone, npn, hireDate, managerId, notes, checklistTemplateId, initialLicense } = parsed.data;

    // Validate managerId belongs to the same org
    if (managerId) {
      const [mgr] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.id, managerId), eq(usersTable.orgId, authReq.orgId)))
        .limit(1);
      if (!mgr) {
        res.status(400).json({ error: "managerId does not belong to this organisation" });
        return;
      }
    }

    const [agent] = await db
      .insert(agentsTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        firstName,
        lastName,
        email,
        phone: phone ?? null,
        npn: npn ?? null,
        hireDate: hireDate ? new Date(hireDate) : null,
        managerId: managerId ?? null,
        notes: notes ?? null,
        status: "onboarding",
      })
      .returning();

    // Create onboarding checklist atomically — roll back agent on failure
    try {
      await createChecklistRun(authReq.orgId, agent!.id, "onboarding", authReq.userId, checklistTemplateId);
    } catch (err: unknown) {
      req.log?.error({ err }, "Failed to auto-create onboarding checklist; rolling back agent");
      await db.delete(agentsTable).where(and(eq(agentsTable.id, agent!.id), eq(agentsTable.orgId, authReq.orgId)));
      res.status(500).json({ error: "Failed to initialise onboarding checklist; agent not created" });
      return;
    }

    // Create initial license record if provided
    if (initialLicense) {
      try {
        await db.insert(stateLicensesTable).values({
          id: randomUUID(),
          agentId: agent!.id,
          stateCode: initialLicense.stateCode,
          licenseType: initialLicense.licenseType,
          licenseNumber: initialLicense.licenseNumber ?? null,
          status: initialLicense.status,
        });
      } catch (err: unknown) {
        req.log?.warn({ err }, "Failed to create initial license for agent");
      }
    }

    res.status(201).json(agent);
  },
);

router.get(
  "/agents/:id",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    let manager: { id: string; fullName: string; email: string; role: string } | null = null;
    if (agent.managerId) {
      const [m] = await db
        .select({ id: usersTable.id, fullName: usersTable.fullName, email: usersTable.email, role: usersTable.role })
        .from(usersTable)
        .where(and(eq(usersTable.id, agent.managerId), eq(usersTable.orgId, authReq.orgId)))
        .limit(1);
      manager = m ?? null;
    }

    const [licenses, certs] = await Promise.all([
      db
        .select()
        .from(stateLicensesTable)
        .where(eq(stateLicensesTable.agentId, agent.id)),
      db
        .select()
        .from(carrierCertificationsTable)
        .where(eq(carrierCertificationsTable.agentId, agent.id)),
    ]);

    const currentYear = new Date().getFullYear();
    const [ahip] = await db
      .select()
      .from(ahipRecordsTable)
      .where(
        and(
          eq(ahipRecordsTable.agentId, agent.id),
          eq(ahipRecordsTable.certificationYear, currentYear),
        ),
      )
      .limit(1);

    const activeLicenses = licenses.filter((l) => l.status === "active").length;
    const activeCerts = certs.filter((c) => c.status === "passed").length;

    res.json({
      ...agent,
      manager,
      licensesCount: licenses.length,
      activeLicensesCount: activeLicenses,
      certificationsCount: certs.length,
      activeCertificationsCount: activeCerts,
      ahipCurrentYear: ahip?.status ?? null,
    });
  },
);

router.patch(
  "/agents/:id",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;

    // Enforce offboarded status lock — agents that have been offboarded
    // cannot have their status reverted via PATCH
    if (data.status !== undefined) {
      const [currentAgent] = await db
        .select({ status: agentsTable.status })
        .from(agentsTable)
        .where(and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);

      if (!currentAgent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      if (currentAgent.status === "offboarded" && data.status !== "offboarded") {
        res.status(409).json({
          error: "Status of offboarded agents cannot be changed",
        });
        return;
      }
    }

    const updates: Partial<Agent> = {};

    if (data.firstName !== undefined) updates.firstName = data.firstName;
    if (data.lastName !== undefined) updates.lastName = data.lastName;
    if (data.email !== undefined) updates.email = data.email;
    if (data.phone !== undefined) updates.phone = data.phone;
    if (data.npn !== undefined) updates.npn = data.npn;
    if (data.status !== undefined) updates.status = data.status;
    if (data.managerId !== undefined) {
      // Validate new managerId belongs to same org (null = clear manager, always allowed)
      if (data.managerId !== null) {
        const [mgr] = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(and(eq(usersTable.id, data.managerId), eq(usersTable.orgId, authReq.orgId)))
          .limit(1);
        if (!mgr) {
          res.status(400).json({ error: "managerId does not belong to this organisation" });
          return;
        }
      }
      updates.managerId = data.managerId;
    }
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.avatarUrl !== undefined) updates.avatarUrl = data.avatarUrl;
    if (data.hireDate !== undefined)
      (updates as Record<string, unknown>).hireDate = data.hireDate ? new Date(data.hireDate) : null;
    if (data.offboardDate !== undefined)
      (updates as Record<string, unknown>).offboardDate = data.offboardDate
        ? new Date(data.offboardDate)
        : null;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const [agent] = await db
      .update(agentsTable)
      .set(updates)
      .where(and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId)))
      .returning();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(agent);
  },
);

router.delete(
  "/agents/:id",
  requireAuth,
  requirePermission("agent", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Soft-delete: set status to offboarded. Retains record for HIPAA audit trail.
    const [agent] = await db
      .update(agentsTable)
      .set({ status: "offboarded", offboardDate: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentsTable.id, raw),
          eq(agentsTable.orgId, authReq.orgId),
          sql`${agentsTable.status} != 'offboarded'`,
        ),
      )
      .returning();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.sendStatus(204);
  },
);

router.post(
  "/agents/:id/offboard",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (agent.status === "offboarded") {
      res.status(409).json({ error: "Agent is already offboarded" });
      return;
    }

    // Create checklist FIRST — only update agent status after successful creation
    // (ensures checklist always exists when status is offboarding)
    let run: Awaited<ReturnType<typeof createChecklistRun>>;
    try {
      run = await createChecklistRun(authReq.orgId, raw, "offboarding", authReq.userId);
    } catch (err: unknown) {
      req.log?.error({ err }, "Failed to create offboarding checklist; status not changed");
      res.status(500).json({ error: "Failed to create offboarding checklist" });
      return;
    }

    const [updated] = await db
      .update(agentsTable)
      .set({ status: "offboarding", offboardDate: new Date() })
      .where(eq(agentsTable.id, raw))
      .returning();

    res.json({ agent: updated, checklistRun: run });
  },
);

// In-memory compliance score cache: agentId → { payload, expiresAt }
const complianceScoreCache = new Map<string, { payload: unknown; expiresAt: number }>();
const COMPLIANCE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

router.get(
  "/agents/:id/compliance-score",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Validate org ownership FIRST — cache must never bypass authorization
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Cache keyed by orgId+agentId so cross-org collisions are impossible
    const cacheKey = `${authReq.orgId}:${raw}`;
    const cached = complianceScoreCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.payload);
      return;
    }

    const currentYear = new Date().getFullYear();

    const [licenses, certs, ahip, onboardingRun] = await Promise.all([
      db
        .select()
        .from(stateLicensesTable)
        .where(eq(stateLicensesTable.agentId, agent.id)),
      db
        .select()
        .from(carrierCertificationsTable)
        .where(eq(carrierCertificationsTable.agentId, agent.id)),
      db
        .select()
        .from(ahipRecordsTable)
        .where(
          and(
            eq(ahipRecordsTable.agentId, agent.id),
            eq(ahipRecordsTable.certificationYear, currentYear),
          ),
        )
        .limit(1),
      db
        .select({ id: checklistRunsTable.id })
        .from(checklistRunsTable)
        .where(
          and(
            eq(checklistRunsTable.agentId, agent.id),
            eq(checklistRunsTable.orgId, authReq.orgId),
            sql`${checklistRunsTable.type} = 'onboarding'`,
          ),
        )
        .orderBy(sql`${checklistRunsTable.startedAt} desc`)
        .limit(1),
    ]);

    let onboardingTaskScore = 0;
    let onboardingCompletedItems = 0;
    let onboardingTotalItems = 0;

    if (onboardingRun[0]) {
      const items = await db
        .select({ status: checklistItemsTable.status })
        .from(checklistItemsTable)
        .where(eq(checklistItemsTable.runId, onboardingRun[0].id));

      onboardingTotalItems = items.length;
      onboardingCompletedItems = items.filter(
        (i) => i.status === "completed" || i.status === "skipped",
      ).length;
      onboardingTaskScore =
        onboardingTotalItems > 0
          ? (onboardingCompletedItems / onboardingTotalItems) * 100
          : 0;
    }

    const activeLicenses = licenses.filter((l) => l.status === "active").length;
    const activeCerts = certs.filter((c) => c.status === "passed").length;
    const ahipCompleted = ahip[0]?.status === "passed";

    const licenseScore =
      licenses.length > 0 ? (activeLicenses / licenses.length) * 100 : 0;
    const certScore =
      certs.length > 0 ? (activeCerts / certs.length) * 100 : 0;
    const ahipScore = ahipCompleted ? 100 : 0;

    const totalScore =
      licenseScore * 0.4 +
      certScore * 0.3 +
      ahipScore * 0.2 +
      onboardingTaskScore * 0.1;

    const payload = {
      agentId: agent.id,
      totalScore: Math.round(totalScore * 10) / 10,
      licenseScore: Math.round(licenseScore * 10) / 10,
      certificationScore: Math.round(certScore * 10) / 10,
      ahipScore,
      onboardingScore: Math.round(onboardingTaskScore * 10) / 10,
      activeLicenses,
      totalLicenses: licenses.length,
      activeCertifications: activeCerts,
      totalCertifications: certs.length,
      ahipCompleted,
      onboardingComplete: onboardingTotalItems > 0 && onboardingCompletedItems >= onboardingTotalItems,
      onboardingCompletedItems,
      onboardingTotalItems,
    };

    complianceScoreCache.set(cacheKey, { payload, expiresAt: Date.now() + COMPLIANCE_CACHE_TTL_MS });
    res.json(payload);
  },
);

router.get(
  "/agents/:id/offboarding-report",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.agentId, agentId),
          eq(documentsTable.orgId, authReq.orgId),
          eq(documentsTable.category, "offboarding"),
        ),
      )
      .orderBy(desc(documentsTable.createdAt))
      .limit(1);

    if (!doc) {
      res.status(404).json({ error: "No offboarding report found. It may still be generating." });
      return;
    }

    res.json({
      id: doc.id,
      name: doc.name,
      storageKey: doc.storageKey,
      mimeType: doc.mimeType,
      fileSizeBytes: doc.fileSizeBytes,
      createdAt: doc.createdAt,
    });
  },
);

router.get(
  "/agents/:id/offboarding-report/download",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.agentId, agentId),
          eq(documentsTable.orgId, authReq.orgId),
          eq(documentsTable.category, "offboarding"),
        ),
      )
      .orderBy(desc(documentsTable.createdAt))
      .limit(1);

    if (!doc) {
      res.status(404).json({ error: "No offboarding report found. It may still be generating." });
      return;
    }

    try {
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const objectStorage = new ObjectStorageService();
      const file = await objectStorage.getObjectEntityFile(doc.storageKey);
      const contentType = doc.mimeType ?? "text/html";
      const safeName = encodeURIComponent(doc.name.replace(/[^\w\s.-]/g, "_"));

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      const dlResponse = await objectStorage.downloadObject(file);
      const buffer = Buffer.from(await dlResponse.arrayBuffer());
      res.send(buffer);
    } catch {
      res.status(500).json({ error: "Failed to retrieve offboarding report file" });
    }
  },
);

export default router;
