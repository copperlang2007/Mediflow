import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, ilike, or, desc, type SQL } from "drizzle-orm";
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
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { randomUUID } from "crypto";
import { createChecklistRun } from "./checklists";

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
  auditMiddleware("agent", undefined, {
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
    const { status, managerId, search, limit, offset } = req.query as {
      status?: string;
      managerId?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };

    const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 200);
    const offsetNum = parseInt(offset ?? "0", 10) || 0;

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

    const [allAgents, totalResult] = await Promise.all([
      db
        .select()
        .from(agentsTable)
        .where(and(...conditions))
        .orderBy(agentsTable.lastName, agentsTable.firstName)
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(agentsTable)
        .where(and(...conditions)),
    ]);

    res.json({
      agents: allAgents,
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
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { firstName, lastName, email, phone, npn, hireDate, managerId, notes, checklistTemplateId, initialLicense } = parsed.data;

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

    // Create onboarding checklist — honour caller-specified template if provided
    createChecklistRun(authReq.orgId, agent!.id, "onboarding", authReq.userId, checklistTemplateId).catch(
      (err: unknown) => {
        req.log?.warn({ err }, "Failed to auto-create onboarding checklist");
      },
    );

    // Create initial license record if provided
    if (initialLicense) {
      db.insert(stateLicensesTable)
        .values({
          id: randomUUID(),
          agentId: agent!.id,
          stateCode: initialLicense.stateCode,
          licenseType: initialLicense.licenseType,
          licenseNumber: initialLicense.licenseNumber ?? null,
          status: initialLicense.status,
        })
        .catch((err: unknown) => {
          req.log?.warn({ err }, "Failed to create initial license for agent");
        });
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

    let manager = null;
    if (agent.managerId) {
      const [m] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, agent.managerId))
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
    if (data.managerId !== undefined) updates.managerId = data.managerId;
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

    const [agent] = await db
      .delete(agentsTable)
      .where(and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId)))
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

    const [updated] = await db
      .update(agentsTable)
      .set({ status: "offboarding", offboardDate: new Date() })
      .where(eq(agentsTable.id, raw))
      .returning();

    const run = await createChecklistRun(authReq.orgId, raw, "offboarding", authReq.userId);

    res.json({ agent: updated, checklistRun: run });
  },
);

router.get(
  "/agents/:id/compliance-score",
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

    res.json({
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
      onboardingComplete: agent.status !== "onboarding",
      onboardingCompletedItems,
      onboardingTotalItems,
    });
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
