import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, ahipRecordsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { getAhipCoverage } from "../lib/agents/ahipCoverage";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

const CreateAhipSchema = z.object({
  certificationYear: z.number().int().min(2020).max(2040),
  status: z.enum(["not_started", "in_progress", "passed", "failed", "waived"]).default("not_started"),
  score: z.number().min(0).max(100).optional(),
  completedDate: z.string().optional(),
  documentKey: z.string().optional(),
});

const UpdateAhipSchema = z.object({
  status: z.enum(["not_started", "in_progress", "passed", "failed", "waived"]).optional(),
  score: z.number().min(0).max(100).nullable().optional(),
  completedDate: z.string().nullable().optional(),
  documentKey: z.string().nullable().optional(),
});

router.use(
  routerAuditMiddleware(router, "agent", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.aid ?? req.params.id;
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
  "/agents/:id/ahip",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const records = await db
      .select()
      .from(ahipRecordsTable)
      .where(eq(ahipRecordsTable.agentId, agentId))
      .orderBy(ahipRecordsTable.certificationYear);

    res.json(records);
  },
);

router.post(
  "/agents/:id/ahip",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = CreateAhipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;

    const [record] = await db
      .insert(ahipRecordsTable)
      .values({
        id: randomUUID(),
        agentId,
        certificationYear: data.certificationYear,
        status: data.status,
        score: data.score ?? null,
        completedDate: data.completedDate ? new Date(data.completedDate) : null,
        documentKey: data.documentKey ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!record) {
      res.status(409).json({ error: `AHIP record for year ${data.certificationYear} already exists for this agent` });
      return;
    }

    res.status(201).json(record);
  },
);

router.patch(
  "/agents/:id/ahip/:aid",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const ahipId = Array.isArray(req.params.aid) ? req.params.aid[0] : req.params.aid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = UpdateAhipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.status !== undefined) updates.status = data.status;
    if (data.score !== undefined) updates.score = data.score;
    if (data.completedDate !== undefined) updates.completedDate = data.completedDate ? new Date(data.completedDate) : null;
    if (data.documentKey !== undefined) updates.documentKey = data.documentKey;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [record] = await db
      .update(ahipRecordsTable)
      .set(updates)
      .where(and(eq(ahipRecordsTable.id, ahipId), eq(ahipRecordsTable.agentId, agentId)))
      .returning();

    if (!record) {
      res.status(404).json({ error: "AHIP record not found" });
      return;
    }

    res.json(record);
  },
);

router.get(
  "/ahip/dashboard",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const year = parseInt((req.query.year as string) ?? String(new Date().getFullYear()), 10);

    const [coverage, completed] = await Promise.all([
      getAhipCoverage(authReq.orgId, year),
      db
        .select({
          agentId: ahipRecordsTable.agentId,
          firstName: agentsTable.firstName,
          lastName: agentsTable.lastName,
          status: ahipRecordsTable.status,
          score: ahipRecordsTable.score,
          completedDate: ahipRecordsTable.completedDate,
        })
        .from(ahipRecordsTable)
        .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            eq(ahipRecordsTable.certificationYear, year),
          ),
        ),
    ]);

    // Shared definition (lib/agents/ahipCoverage.ts): agents who need AHIP
    // are active + onboarding; complete = passed or waived. Renewals, the
    // dashboard and the executive report use the same numbers.
    res.json({
      year,
      totalActiveAgents: coverage.agentsRequiringAhip,
      agentsRequiringAhip: coverage.agentsRequiringAhip,
      passedCount: coverage.complete,
      completionRate: coverage.completionRate,
      records: completed,
    });
  },
);

export default router;
