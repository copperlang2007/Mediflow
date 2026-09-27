import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  carriersTable,
  carrierCertificationsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

const CreateCertSchema = z.object({
  carrierId: z.string().min(1),
  certificationYear: z.number().int().min(2020).max(2040),
  status: z.enum(["not_started", "in_progress", "passed", "failed", "waived"]).default("not_started"),
  completedDate: z.string().optional(),
  expiryDate: z.string().optional(),
  score: z.number().min(0).max(100).optional(),
  documentKey: z.string().optional(),
});

const UpdateCertSchema = z.object({
  status: z.enum(["not_started", "in_progress", "passed", "failed", "waived"]).optional(),
  completedDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
  documentKey: z.string().nullable().optional(),
});

router.use(
  routerAuditMiddleware(router, "certification", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.cid ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

async function getAgentOrFail(agentId: string, orgId: string, res: Response): Promise<boolean> {
  const [agent] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return false;
  }
  return true;
}

router.get(
  "/agents/:id/certifications",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const certs = await db
      .select({
        id: carrierCertificationsTable.id,
        agentId: carrierCertificationsTable.agentId,
        carrierId: carrierCertificationsTable.carrierId,
        carrierName: carriersTable.name,
        certificationYear: carrierCertificationsTable.certificationYear,
        status: carrierCertificationsTable.status,
        completedDate: carrierCertificationsTable.completedDate,
        expiryDate: carrierCertificationsTable.expiryDate,
        score: carrierCertificationsTable.score,
        documentKey: carrierCertificationsTable.documentKey,
        createdAt: carrierCertificationsTable.createdAt,
        updatedAt: carrierCertificationsTable.updatedAt,
      })
      .from(carrierCertificationsTable)
      .innerJoin(carriersTable, eq(carrierCertificationsTable.carrierId, carriersTable.id))
      .where(eq(carrierCertificationsTable.agentId, agentId))
      .orderBy(
        carrierCertificationsTable.certificationYear,
        carriersTable.name,
      );

    res.json(certs);
  },
);

router.post(
  "/agents/:id/certifications",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = CreateCertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;

    const [carrier] = await db
      .select({ id: carriersTable.id })
      .from(carriersTable)
      .where(and(eq(carriersTable.id, data.carrierId), eq(carriersTable.orgId, authReq.orgId)))
      .limit(1);

    if (!carrier) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    const [cert] = await db
      .insert(carrierCertificationsTable)
      .values({
        id: randomUUID(),
        agentId,
        carrierId: data.carrierId,
        certificationYear: data.certificationYear,
        status: data.status,
        completedDate: data.completedDate ? new Date(data.completedDate) : null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        score: data.score ?? null,
        documentKey: data.documentKey ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!cert) {
      res.status(409).json({ error: `Certification for carrier ${data.carrierId} in year ${data.certificationYear} already exists for this agent` });
      return;
    }

    res.status(201).json(cert);
  },
);

router.patch(
  "/agents/:id/certifications/:cid",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const certId = Array.isArray(req.params.cid) ? req.params.cid[0] : req.params.cid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = UpdateCertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.status !== undefined) updates.status = data.status;
    if (data.completedDate !== undefined) updates.completedDate = data.completedDate ? new Date(data.completedDate) : null;
    if (data.expiryDate !== undefined) updates.expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
    if (data.score !== undefined) updates.score = data.score;
    if (data.documentKey !== undefined) updates.documentKey = data.documentKey;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [cert] = await db
      .update(carrierCertificationsTable)
      .set(updates)
      .where(and(eq(carrierCertificationsTable.id, certId), eq(carrierCertificationsTable.agentId, agentId)))
      .returning();

    if (!cert) {
      res.status(404).json({ error: "Certification not found" });
      return;
    }

    res.json(cert);
  },
);

router.delete(
  "/agents/:id/certifications/:cid",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const certId = Array.isArray(req.params.cid) ? req.params.cid[0] : req.params.cid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const [deleted] = await db
      .delete(carrierCertificationsTable)
      .where(and(eq(carrierCertificationsTable.id, certId), eq(carrierCertificationsTable.agentId, agentId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Certification not found" });
      return;
    }

    res.sendStatus(204);
  },
);

router.get(
  "/certifications/matrix",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const year = parseInt((req.query.year as string) ?? String(new Date().getFullYear()), 10);

    const [carriers, agents, certs] = await Promise.all([
      db
        .select()
        .from(carriersTable)
        .where(and(eq(carriersTable.orgId, authReq.orgId), eq(carriersTable.isActive, true)))
        .orderBy(carriersTable.name),
      db
        .select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName, status: agentsTable.status })
        .from(agentsTable)
        .where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.status, "active")))
        .orderBy(agentsTable.lastName),
      db
        .select({
          agentId: carrierCertificationsTable.agentId,
          carrierId: carrierCertificationsTable.carrierId,
          status: carrierCertificationsTable.status,
        })
        .from(carrierCertificationsTable)
        .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .where(
          and(
            eq(carrierCertificationsTable.certificationYear, year),
            eq(agentsTable.orgId, authReq.orgId),
          ),
        ),
    ]);

    const certMap: Record<string, Record<string, string>> = {};
    for (const row of certs) {
      certMap[row.agentId] ??= {};
      certMap[row.agentId][row.carrierId] = row.status;
    }

    res.json({ year, carriers, agents, certMap });
  },
);

export default router;
