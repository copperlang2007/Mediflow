import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, ilike, or, type SQL } from "drizzle-orm";
import {
  db,
  agentsTable,
  usersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
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

const CreateAgentSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  npn: z.string().max(20).optional(),
  hireDate: z.string().optional(),
  managerId: z.string().optional(),
  notes: z.string().max(5000).optional(),
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
        .orderBy(agentsTable.createdAt)
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

    const { firstName, lastName, email, phone, npn, hireDate, managerId, notes } = parsed.data;

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
    const [licenses, certs, ahip] = await Promise.all([
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
    ]);

    const activeLicenses = licenses.filter((l) => l.status === "active").length;
    const activeCerts = certs.filter((c) => c.status === "passed").length;
    const ahipCompleted = ahip[0]?.status === "passed";

    const licenseScore =
      licenses.length > 0 ? (activeLicenses / licenses.length) * 100 : 0;
    const certScore =
      certs.length > 0 ? (activeCerts / certs.length) * 100 : 0;
    const ahipScore = ahipCompleted ? 100 : 0;
    const onboardingScore = agent.status !== "onboarding" ? 100 : 50;

    const totalScore =
      licenseScore * 0.35 +
      certScore * 0.3 +
      ahipScore * 0.2 +
      onboardingScore * 0.15;

    res.json({
      agentId: agent.id,
      totalScore: Math.round(totalScore * 10) / 10,
      licenseScore: Math.round(licenseScore * 10) / 10,
      certificationScore: Math.round(certScore * 10) / 10,
      ahipScore,
      onboardingScore,
      activeLicenses,
      totalLicenses: licenses.length,
      activeCertifications: activeCerts,
      totalCertifications: certs.length,
      ahipCompleted,
      onboardingComplete: agent.status !== "onboarding",
    });
  },
);

export default router;
