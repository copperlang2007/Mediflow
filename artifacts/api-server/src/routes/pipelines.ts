import { Router, type IRouter, type Request, type Response } from "express";
import { eq, ne, and, sql, desc, asc, isNull } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  pipelinesTable,
  pipelineStagesTable,
  dealsTable,
  dealStageHistoryTable,
  contactsTable,
  activitiesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware, scopeToRouter } from "../middlewares/auditMiddleware";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

const router: IRouter = Router();

router.use(
  scopeToRouter(router, auditMiddleware("deal", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  })),
);

// ---- Pipelines ----

router.get("/pipelines", requireAuth, requirePermission("contact", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const pipelines = await db.select().from(pipelinesTable).where(eq(pipelinesTable.orgId, authReq.orgId)).orderBy(asc(pipelinesTable.createdAt));
  // Attach stages to each pipeline — guard against empty IN () when no pipelines exist
  const stageRows = pipelines.length > 0
    ? await db.select().from(pipelineStagesTable).where(sql`${pipelineStagesTable.pipelineId} IN (${sql.join(pipelines.map((p) => sql`${p.id}`), sql`, `)})`).orderBy(asc(pipelineStagesTable.orderIndex))
    : [];
  const stagesByPipeline = new Map<string, typeof stageRows>();
  for (const s of stageRows) {
    if (!stagesByPipeline.has(s.pipelineId)) stagesByPipeline.set(s.pipelineId, []);
    stagesByPipeline.get(s.pipelineId)!.push(s);
  }
  res.json(pipelines.map((p) => ({ ...p, stages: stagesByPipeline.get(p.id) ?? [] })));
});

router.post("/pipelines", requireAuth, requirePermission("contact", "create"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const Schema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    stages: z.array(z.object({ name: z.string(), color: z.string().optional(), probabilityPct: z.number().int().min(0).max(100).optional() })).optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

  const [pipeline] = await db.insert(pipelinesTable).values({ id: randomUUID(), orgId: authReq.orgId, name: parsed.data.name, description: parsed.data.description ?? null, isDefault: parsed.data.isDefault ?? false }).returning();

  const stages = [];
  for (let i = 0; i < (parsed.data.stages ?? []).length; i++) {
    const s = parsed.data.stages![i];
    const [stage] = await db.insert(pipelineStagesTable).values({ id: randomUUID(), pipelineId: pipeline.id, name: s.name, orderIndex: i, color: s.color ?? "#6366f1", probabilityPct: s.probabilityPct ?? 0 }).returning();
    stages.push(stage);
  }
  res.status(201).json({ ...pipeline, stages });
});

router.get("/pipelines/:id", requireAuth, requirePermission("contact", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [pipeline] = await db.select().from(pipelinesTable).where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!pipeline) { res.status(404).json({ error: "Pipeline not found" }); return; }
  const stages = await db.select().from(pipelineStagesTable).where(eq(pipelineStagesTable.pipelineId, id)).orderBy(asc(pipelineStagesTable.orderIndex));
  res.json({ ...pipeline, stages });
});

router.patch("/pipelines/:id", requireAuth, requirePermission("contact", "update"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [existing] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Pipeline not found" }); return; }
  const Schema = z.object({ name: z.string().min(1).max(100).optional(), description: z.string().nullable().optional(), isDefault: z.boolean().optional() });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
  const [updated] = await db.update(pipelinesTable).set({ ...parsed.data }).where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.orgId, authReq.orgId))).returning();
  res.json(updated);
});

router.delete("/pipelines/:id", requireAuth, requirePermission("contact", "delete"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [existing] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Pipeline not found" }); return; }
  await db.delete(pipelinesTable).where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.orgId, authReq.orgId)));
  res.status(204).send();
});

// ---- Stages ----

router.post("/pipelines/:id/stages", requireAuth, requirePermission("contact", "update"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const pipelineId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [pipeline] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, pipelineId), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!pipeline) { res.status(404).json({ error: "Pipeline not found" }); return; }
  const Schema = z.object({ name: z.string().min(1).max(100), color: z.string().optional(), probabilityPct: z.number().int().min(0).max(100).optional(), orderIndex: z.number().int().optional() });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
  const maxOrder = await db.select({ m: sql<number>`coalesce(max(${pipelineStagesTable.orderIndex}), -1)` }).from(pipelineStagesTable).where(eq(pipelineStagesTable.pipelineId, pipelineId));
  const orderIndex = parsed.data.orderIndex ?? Number(maxOrder[0]?.m ?? -1) + 1;
  const [stage] = await db.insert(pipelineStagesTable).values({ id: randomUUID(), pipelineId, name: parsed.data.name, orderIndex, color: parsed.data.color ?? "#6366f1", probabilityPct: parsed.data.probabilityPct ?? 0 }).returning();
  res.status(201).json(stage);
});

router.patch("/pipelines/:id/stages/:sid", requireAuth, requirePermission("contact", "update"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const pipelineId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const sid = Array.isArray(req.params.sid) ? req.params.sid[0] : req.params.sid;
  const [pipeline] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, pipelineId), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!pipeline) { res.status(404).json({ error: "Pipeline not found" }); return; }
  const [stage] = await db.select({ id: pipelineStagesTable.id }).from(pipelineStagesTable).where(and(eq(pipelineStagesTable.id, sid), eq(pipelineStagesTable.pipelineId, pipelineId))).limit(1);
  if (!stage) { res.status(404).json({ error: "Stage not found" }); return; }
  const Schema = z.object({ name: z.string().min(1).max(100).optional(), color: z.string().optional(), probabilityPct: z.number().int().min(0).max(100).optional(), orderIndex: z.number().int().optional() });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
  const [updated] = await db.update(pipelineStagesTable).set({ ...parsed.data }).where(eq(pipelineStagesTable.id, sid)).returning();
  res.json(updated);
});

router.delete("/pipelines/:id/stages/:sid", requireAuth, requirePermission("contact", "delete"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const pipelineId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const sid = Array.isArray(req.params.sid) ? req.params.sid[0] : req.params.sid;
  const [pipeline] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, pipelineId), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!pipeline) { res.status(404).json({ error: "Pipeline not found" }); return; }
  await db.delete(pipelineStagesTable).where(and(eq(pipelineStagesTable.id, sid), eq(pipelineStagesTable.pipelineId, pipelineId)));
  res.status(204).send();
});

// ---- Deals ----

router.get("/deals", requireAuth, requirePermission("contact", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const { pipelineId, stageId, status, contactId, limit, offset } = req.query as Record<string, string | undefined>;
  const conditions = [eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)];
  if (pipelineId) conditions.push(eq(dealsTable.pipelineId, pipelineId));
  if (stageId) conditions.push(eq(dealsTable.stageId, stageId));
  if (status) conditions.push(eq(dealsTable.status, status as "open" | "won" | "lost"));
  if (contactId) conditions.push(eq(dealsTable.contactId, contactId));
  const limitNum = safeLimit(limit, 100, 500);
  const offsetNum = safeOffset(offset);
  const deals = await db
    .select({ deal: dealsTable, contactFirstName: contactsTable.firstName, contactLastName: contactsTable.lastName, contactEmail: contactsTable.email })
    .from(dealsTable)
    .innerJoin(contactsTable, eq(dealsTable.contactId, contactsTable.id))
    .where(and(...conditions))
    .orderBy(desc(dealsTable.updatedAt))
    .limit(limitNum)
    .offset(offsetNum);
  res.json(deals);
});

router.post("/deals", requireAuth, requirePermission("contact", "create"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const Schema = z.object({
    pipelineId: z.string(),
    stageId: z.string(),
    contactId: z.string(),
    title: z.string().min(1).max(200),
    valueEst: z.number().optional().nullable(),
    closeDateEst: z.string().optional().nullable(),
    assignedAgentId: z.string().optional().nullable(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

  // Verify pipeline belongs to org
  const [pipeline] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, parsed.data.pipelineId), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!pipeline) { res.status(400).json({ error: "Pipeline not found" }); return; }
  // Verify stage belongs to this specific pipeline (prevents cross-pipeline / cross-tenant stage injection)
  const [stage] = await db.select({ id: pipelineStagesTable.id }).from(pipelineStagesTable).where(and(eq(pipelineStagesTable.id, parsed.data.stageId), eq(pipelineStagesTable.pipelineId, parsed.data.pipelineId))).limit(1);
  if (!stage) { res.status(400).json({ error: "Stage not found in specified pipeline" }); return; }
  // Verify contact belongs to org
  const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, parsed.data.contactId), eq(contactsTable.orgId, authReq.orgId))).limit(1);
  if (!contact) { res.status(400).json({ error: "Contact not found" }); return; }

  const dealId = randomUUID();
  const [deal] = await db.insert(dealsTable).values({
    id: dealId, orgId: authReq.orgId, pipelineId: parsed.data.pipelineId, stageId: parsed.data.stageId,
    contactId: parsed.data.contactId, title: parsed.data.title, valueEst: parsed.data.valueEst ?? null,
    closeDateEst: parsed.data.closeDateEst ? new Date(parsed.data.closeDateEst) : null,
    assignedAgentId: parsed.data.assignedAgentId ?? null, status: "open",
  }).returning();

  // Record stage history
  await db.insert(dealStageHistoryTable).values({ id: randomUUID(), dealId, fromStageId: null, toStageId: parsed.data.stageId, changedByUserId: authReq.userId });

  res.status(201).json(deal);
});

router.get("/deals/:id", requireAuth, requirePermission("contact", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [row] = await db
    .select({ deal: dealsTable, contactFirstName: contactsTable.firstName, contactLastName: contactsTable.lastName, contactEmail: contactsTable.email })
    .from(dealsTable)
    .innerJoin(contactsTable, eq(dealsTable.contactId, contactsTable.id))
    .where(and(eq(dealsTable.id, id), eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Deal not found" }); return; }
  const history = await db.select().from(dealStageHistoryTable).where(eq(dealStageHistoryTable.dealId, id)).orderBy(desc(dealStageHistoryTable.changedAt));
  res.json({ ...row, history });
});

// PATCH /deals/:id
//
// Concurrency note: the previous handler read the row, computed
// `d.stageId !== existing.stageId` in JS, then wrote the new stage and
// inserted the history row + activity row + fired `deal_stage_changed`
// based on that JS comparison. Two concurrent callers each moving the
// deal from stage A to stage B would both observe `existing.stageId = A`
// in their pre-write read, both write `stage = B`, and both insert
// duplicate history + activity rows and double-fire the trigger.
//
// The fix performs the stage transition with a conditional UPDATE
// (`WHERE stage_id != newStageId`). Only the caller whose UPDATE actually
// flipped the stage sees `returning()` non-empty, and only that caller
// writes the history row, the activity row, and enqueues the trigger.
// All three side effects + the conditional UPDATE run in a single
// `db.transaction` so a crash partway through cannot leave a history
// entry pointing at a transition the deal didn't actually take.
router.patch("/deals/:id", requireAuth, requirePermission("contact", "update"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const Schema = z.object({
    stageId: z.string().optional(),
    title: z.string().min(1).max(200).optional(),
    valueEst: z.number().nullable().optional(),
    status: z.enum(["open", "won", "lost"]).optional(),
    lostReason: z.string().nullable().optional(),
    closeDateEst: z.string().nullable().optional(),
    assignedAgentId: z.string().nullable().optional(),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(dealsTable)
      .where(and(eq(dealsTable.id, id), eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)))
      .limit(1);
    if (!existing) { return { kind: "not-found" as const }; }

    // If moving to a new stage, verify it belongs to the deal's pipeline (prevents cross-pipeline injection)
    if (d.stageId !== undefined && d.stageId !== existing.stageId) {
      const [stageCheck] = await tx
        .select({ id: pipelineStagesTable.id })
        .from(pipelineStagesTable)
        .where(and(eq(pipelineStagesTable.id, d.stageId), eq(pipelineStagesTable.pipelineId, existing.pipelineId)))
        .limit(1);
      if (!stageCheck) { return { kind: "bad-stage" as const }; }
    }

    const baseUpdates: Record<string, unknown> = {};
    if (d.title !== undefined) baseUpdates.title = d.title;
    if (d.valueEst !== undefined) baseUpdates.valueEst = d.valueEst;
    if (d.lostReason !== undefined) baseUpdates.lostReason = d.lostReason;
    if (d.closeDateEst !== undefined) baseUpdates.closeDateEst = d.closeDateEst ? new Date(d.closeDateEst) : null;
    if (d.assignedAgentId !== undefined) baseUpdates.assignedAgentId = d.assignedAgentId;
    if (d.status !== undefined) {
      baseUpdates.status = d.status;
      if (d.status === "won") baseUpdates.wonAt = new Date();
      if (d.status === "lost") baseUpdates.lostAt = new Date();
    }

    let transitioned = false;
    let fromStageId: string | null = null;
    let updatedRow: typeof dealsTable.$inferSelect | undefined;

    if (d.stageId !== undefined) {
      // Conditional UPDATE gated on stage actually changing. Postgres
      // serializes concurrent UPDATEs against the same row, so at most
      // one caller will see a non-empty `returning()` for this clause.
      const [updated] = await tx
        .update(dealsTable)
        .set({ ...baseUpdates, stageId: d.stageId })
        .where(
          and(
            eq(dealsTable.id, id),
            eq(dealsTable.orgId, authReq.orgId),
            isNull(dealsTable.deletedAt),
            ne(dealsTable.stageId, d.stageId),
          ),
        )
        .returning();

      if (updated) {
        transitioned = true;
        fromStageId = existing.stageId;
        updatedRow = updated;
      } else {
        // Stage already == d.stageId. Still apply any non-stage fields
        // in the payload (keeps existing semantics where PATCH always
        // commits the rest of the payload).
        if (Object.keys(baseUpdates).length > 0) {
          const [updated2] = await tx
            .update(dealsTable)
            .set(baseUpdates)
            .where(and(eq(dealsTable.id, id), eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)))
            .returning();
          updatedRow = updated2;
        } else {
          updatedRow = existing;
        }
      }
    } else if (Object.keys(baseUpdates).length > 0) {
      const [updated] = await tx
        .update(dealsTable)
        .set(baseUpdates)
        .where(and(eq(dealsTable.id, id), eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)))
        .returning();
      updatedRow = updated;
    } else {
      updatedRow = existing;
    }

    // Only the caller whose conditional UPDATE actually moved the deal
    // writes the history + activity rows here. Two concurrent same-stage
    // PATCHes cannot both reach this branch.
    if (transitioned && d.stageId) {
      await tx.insert(dealStageHistoryTable).values({
        id: randomUUID(),
        dealId: id,
        fromStageId,
        toStageId: d.stageId,
        changedByUserId: authReq.userId,
      });
      await tx.insert(activitiesTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        contactId: existing.contactId,
        dealId: id,
        type: "status_change",
        body: `Deal moved to new stage`,
        createdBy: authReq.userId,
      });
    }

    return {
      kind: "ok" as const,
      row: updatedRow,
      transitioned,
      fromStageId,
      toStageId: d.stageId ?? null,
      contactId: existing.contactId,
    };
  });

  if (result.kind === "not-found") { res.status(404).json({ error: "Deal not found" }); return; }
  if (result.kind === "bad-stage") { res.status(400).json({ error: "Stage not found in deal's pipeline" }); return; }

  // Enqueue the automation trigger OUTSIDE the transaction, only on a
  // real transition. The transaction has already committed the history
  // row + activity row; the worker is a best-effort follow-up.
  if (result.transitioned && result.toStageId) {
    enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId: authReq.orgId,
      trigger: "deal_stage_changed",
      resourceType: "deal",
      resourceId: id,
      context: { fromStageId: result.fromStageId, toStageId: result.toStageId, contactId: result.contactId },
    }).catch((err) => {
      logger.warn(
        {
          err,
          jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
          trigger: "deal_stage_changed",
          orgId: authReq.orgId,
          dealId: id,
          contactId: result.contactId,
        },
        "Failed to enqueue automation job",
      );
      captureWorkerError(err, {
        worker: "pipelines",
        route: "PATCH /deals/:id",
        jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
        trigger: "deal_stage_changed",
        orgId: authReq.orgId,
        dealId: id,
      });
    });
  }

  res.json(result.row);
});

// DELETE /deals/:id — soft-delete (sets deletedAt; hard-delete requires admin retention confirmation)
router.delete("/deals/:id", requireAuth, requirePermission("contact", "delete"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [existing] = await db.select({ id: dealsTable.id }).from(dealsTable)
    .where(and(eq(dealsTable.id, id), eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "Deal not found" }); return; }
  await db.update(dealsTable).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(dealsTable.id, id), eq(dealsTable.orgId, authReq.orgId)));
  res.sendStatus(204);
});

// GET /pipelines/:id/analytics
router.get("/pipelines/:id/analytics", requireAuth, requirePermission("contact", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const pipelineId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [pipeline] = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(and(eq(pipelinesTable.id, pipelineId), eq(pipelinesTable.orgId, authReq.orgId))).limit(1);
  if (!pipeline) { res.status(404).json({ error: "Pipeline not found" }); return; }

  const stages = await db.select().from(pipelineStagesTable).where(eq(pipelineStagesTable.pipelineId, pipelineId)).orderBy(asc(pipelineStagesTable.orderIndex));
  const deals = await db.select().from(dealsTable).where(and(eq(dealsTable.pipelineId, pipelineId), eq(dealsTable.orgId, authReq.orgId), isNull(dealsTable.deletedAt)));

  const now = Date.now();
  const stageAnalytics = stages.map((stage) => {
    const stageDeals = deals.filter((d) => d.stageId === stage.id && d.status === "open");
    const totalValue = stageDeals.reduce((sum, d) => sum + (d.valueEst ?? 0), 0);
    const avgDaysInStage = stageDeals.length > 0
      ? stageDeals.reduce((sum, d) => sum + Math.floor((now - d.createdAt.getTime()) / 86400000), 0) / stageDeals.length
      : 0;
    return { stageId: stage.id, stageName: stage.name, dealCount: stageDeals.length, totalValue, avgDaysInStage: Math.round(avgDaysInStage), probability: stage.probabilityPct };
  });

  const totalDeals = deals.length;
  const wonDeals = deals.filter((d) => d.status === "won");
  const lostDeals = deals.filter((d) => d.status === "lost");
  const openDeals = deals.filter((d) => d.status === "open");
  const conversionRate = totalDeals > 0 ? Math.round((wonDeals.length / totalDeals) * 100) : 0;

  const sumValues = (rows: { valueEst: number | null }[]): number =>
    rows.reduce((sum, d) => sum + (d.valueEst ?? 0), 0);

  res.json({
    stageAnalytics,
    totalDeals,
    wonDeals: wonDeals.length,
    lostDeals: lostDeals.length,
    openDeals: openDeals.length,
    conversionRate,
    openValueTotal: sumValues(openDeals),
    wonValueTotal: sumValues(wonDeals),
    lostValueTotal: sumValues(lostDeals),
  });
});

export default router;
