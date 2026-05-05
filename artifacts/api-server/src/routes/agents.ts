import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, ilike, or } from "drizzle-orm";
import {
  db,
  agentsTable,
  usersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { randomUUID } from "crypto";

const router: IRouter = Router();

router.get(
  "/agents",
  requireAuth,
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

    const conditions = [eq(agentsTable.orgId, authReq.orgId)];

    if (status) {
      conditions.push(eq(agentsTable.status, status as any));
    }
    if (managerId) {
      conditions.push(eq(agentsTable.managerId, managerId));
    }
    if (search) {
      conditions.push(
        or(
          ilike(agentsTable.firstName, `%${search}%`),
          ilike(agentsTable.lastName, `%${search}%`),
          ilike(agentsTable.email, `%${search}%`)
        ) as any
      );
    }

    const allAgents = await db
      .select()
      .from(agentsTable)
      .where(and(...conditions))
      .orderBy(agentsTable.createdAt)
      .limit(limitNum)
      .offset(offsetNum);

    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentsTable)
      .where(and(...conditions));

    res.json({
      agents: allAgents,
      total: Number(totalResult[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
  }
);

router.post(
  "/agents",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const {
      firstName,
      lastName,
      email,
      phone,
      npn,
      hireDate,
      managerId,
      notes,
    } = req.body as {
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      npn?: string;
      hireDate?: string;
      managerId?: string;
      notes?: string;
    };

    if (!firstName || !lastName || !email) {
      res.status(400).json({ error: "firstName, lastName, email are required" });
      return;
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

    res.status(201).json(agent);
  }
);

router.get(
  "/agents/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(
        and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId))
      )
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

    const licenses = await db
      .select()
      .from(stateLicensesTable)
      .where(eq(stateLicensesTable.agentId, agent.id));

    const certs = await db
      .select()
      .from(carrierCertificationsTable)
      .where(eq(carrierCertificationsTable.agentId, agent.id));

    const currentYear = new Date().getFullYear();
    const [ahip] = await db
      .select()
      .from(ahipRecordsTable)
      .where(
        and(
          eq(ahipRecordsTable.agentId, agent.id),
          eq(ahipRecordsTable.certificationYear, currentYear)
        )
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
  }
);

router.patch(
  "/agents/:id",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const allowed = [
      "firstName",
      "lastName",
      "email",
      "phone",
      "npn",
      "status",
      "hireDate",
      "offboardDate",
      "managerId",
      "notes",
      "avatarUrl",
    ] as const;

    const updates: Record<string, unknown> = {};
    const body = req.body as Record<string, unknown>;
    for (const key of allowed) {
      if (key in body) {
        if (key === "hireDate" || key === "offboardDate") {
          updates[key === "hireDate" ? "hireDate" : "offboardDate"] = body[key]
            ? new Date(body[key] as string)
            : null;
        } else {
          const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
          updates[snakeKey] = body[key];
        }
      }
    }

    const [agent] = await db
      .update(agentsTable)
      .set(updates as any)
      .where(
        and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId))
      )
      .returning();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(agent);
  }
);

router.delete(
  "/agents/:id",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .delete(agentsTable)
      .where(
        and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId))
      )
      .returning();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.sendStatus(204);
  }
);

router.get(
  "/agents/:id/compliance-score",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(
        and(eq(agentsTable.id, raw), eq(agentsTable.orgId, authReq.orgId))
      )
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
            eq(ahipRecordsTable.certificationYear, currentYear)
          )
        )
        .limit(1),
    ]);

    const activeLicenses = licenses.filter((l) => l.status === "active").length;
    const activeCerts = certs.filter((c) => c.status === "passed").length;
    const ahipCompleted = ahip[0]?.status === "passed";

    const licenseScore = licenses.length > 0 ? (activeLicenses / licenses.length) * 100 : 0;
    const certScore = certs.length > 0 ? (activeCerts / certs.length) * 100 : 0;
    const ahipScore = ahipCompleted ? 100 : 0;
    const onboardingScore = agent.status !== "onboarding" ? 100 : 50;

    const totalScore =
      licenseScore * 0.35 +
      certScore * 0.30 +
      ahipScore * 0.20 +
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
  }
);

export default router;
