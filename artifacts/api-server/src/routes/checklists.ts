import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  checklistRunsTable,
  checklistItemsTable,
  taskTemplatesTable,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

export const ONBOARDING_ITEMS = [
  { title: "Collect E&O certificate", description: "Obtain Errors & Omissions insurance certificate from agent", required: true, orderIndex: 1 },
  { title: "Confirm NPN number", description: "Verify agent's National Producer Number in NIPR", required: true, orderIndex: 2 },
  { title: "Enter all state licenses", description: "Record all active state insurance licenses with expiry dates", required: true, orderIndex: 3 },
  { title: "Complete carrier certifications", description: "Agent completes required carrier certification courses", required: true, orderIndex: 4 },
  { title: "Complete AHIP training", description: "Agent completes Annual AHIP Medicare certification", required: true, orderIndex: 5 },
  { title: "Provision tech stack accounts", description: "Set up CRM, quoting tool, and communication platform accounts", required: true, orderIndex: 6 },
  { title: "Sign agency agreement", description: "Agent executes agency producer agreement", required: true, orderIndex: 7 },
  { title: "Complete compliance training", description: "Agent completes agency compliance and code of conduct training", required: false, orderIndex: 8 },
];

export const OFFBOARDING_ITEMS = [
  { title: "Submit final production report", description: "Generate and file final sales and enrollment report", required: true, orderIndex: 1 },
  { title: "Transfer or reassign open leads", description: "Reassign all active CRM leads to other agents", required: true, orderIndex: 2 },
  { title: "Deprovision CRM access", description: "Remove agent login from CRM platform", required: true, orderIndex: 3 },
  { title: "Deprovision quoting tool access", description: "Remove agent login from quoting and enrollment platform", required: true, orderIndex: 4 },
  { title: "Deprovision email and communication accounts", description: "Disable agency email and communication tool access", required: true, orderIndex: 5 },
  { title: "Notify carriers of termination", description: "Send carrier termination notices per contract requirements", required: true, orderIndex: 6 },
  { title: "Collect agency property", description: "Retrieve any agency-issued equipment or materials", required: false, orderIndex: 7 },
  { title: "Complete COBRA / benefits paperwork", description: "Process benefits continuation paperwork if applicable", required: false, orderIndex: 8 },
  { title: "File state termination notices", description: "Submit license appointment terminations with state DOI", required: true, orderIndex: 9 },
  { title: "Archive agent records", description: "Move agent records to long-term compliance archive", required: true, orderIndex: 10 },
];

export async function createChecklistRun(
  orgId: string,
  agentId: string,
  type: "onboarding" | "offboarding",
  startedByUserId?: string,
): Promise<typeof checklistRunsTable.$inferSelect> {
  const runId = randomUUID();

  // Try to load checklist items from DB templates first (admin-customizable)
  const [dbTemplate] = await db
    .select({ steps: taskTemplatesTable.steps })
    .from(taskTemplatesTable)
    .where(
      and(
        eq(taskTemplatesTable.orgId, orgId),
        eq(taskTemplatesTable.type, type),
        eq(taskTemplatesTable.isActive, true),
      ),
    )
    .orderBy(taskTemplatesTable.createdAt)
    .limit(1);

  type ItemDef = { title: string; description?: string; required: boolean; orderIndex: number };
  let items: ItemDef[];

  if (dbTemplate?.steps && Array.isArray(dbTemplate.steps) && dbTemplate.steps.length > 0) {
    items = (dbTemplate.steps as Array<Record<string, unknown>>).map((step, i) => ({
      title: String(step.title ?? `Step ${i + 1}`),
      description: step.description != null ? String(step.description) : undefined,
      required: step.required !== false,
      orderIndex: typeof step.orderIndex === "number" ? step.orderIndex : i + 1,
    }));
  } else {
    items = type === "onboarding" ? ONBOARDING_ITEMS : OFFBOARDING_ITEMS;
  }

  const [run] = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(checklistRunsTable)
      .values({
        id: runId,
        orgId,
        agentId,
        type,
        status: "in_progress",
        startedAt: new Date(),
        completedBy: startedByUserId ?? null,
      })
      .returning();

    await tx.insert(checklistItemsTable).values(
      items.map((item) => ({
        id: randomUUID(),
        runId,
        title: item.title,
        description: item.description,
        required: item.required,
        orderIndex: item.orderIndex,
        status: "pending" as const,
      })),
    );

    return [r!];
  });

  return run!;
}

router.use(
  auditMiddleware("task_instance", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.runId ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

router.get(
  "/agents/:id/checklists",
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

    const runs = await db
      .select()
      .from(checklistRunsTable)
      .where(
        and(
          eq(checklistRunsTable.agentId, agentId),
          eq(checklistRunsTable.orgId, authReq.orgId),
        ),
      )
      .orderBy(checklistRunsTable.startedAt);

    res.json(runs);
  },
);

router.get(
  "/agents/:id/checklists/:runId",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;

    const [run] = await db
      .select()
      .from(checklistRunsTable)
      .where(
        and(
          eq(checklistRunsTable.id, runId),
          eq(checklistRunsTable.agentId, agentId),
          eq(checklistRunsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Checklist run not found" });
      return;
    }

    const items = await db
      .select()
      .from(checklistItemsTable)
      .where(eq(checklistItemsTable.runId, runId))
      .orderBy(checklistItemsTable.orderIndex);

    res.json({ ...run, items });
  },
);

router.post(
  "/agents/:id/checklists",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = z
      .object({ type: z.enum(["onboarding", "offboarding"]) })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "type must be 'onboarding' or 'offboarding'" });
      return;
    }

    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const run = await createChecklistRun(authReq.orgId, agentId, parsed.data.type, authReq.userId);

    res.status(201).json(run);
  },
);

router.patch(
  "/checklists/:runId/items/:itemId",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const itemId = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;

    const parsed = z
      .object({
        status: z.enum(["pending", "completed", "skipped"]),
        notes: z.string().max(1000).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const [run] = await db
      .select({
        id: checklistRunsTable.id,
        orgId: checklistRunsTable.orgId,
        agentId: checklistRunsTable.agentId,
        type: checklistRunsTable.type,
      })
      .from(checklistRunsTable)
      .where(eq(checklistRunsTable.id, runId))
      .limit(1);

    if (!run || run.orgId !== authReq.orgId) {
      res.status(404).json({ error: "Checklist run not found" });
      return;
    }

    const { status, notes } = parsed.data;

    const [item] = await db
      .update(checklistItemsTable)
      .set({
        status,
        notes: notes ?? null,
        completedAt: status === "completed" ? new Date() : null,
        completedByUserId: status === "completed" ? authReq.userId : null,
      })
      .where(and(eq(checklistItemsTable.id, itemId), eq(checklistItemsTable.runId, runId)))
      .returning();

    if (!item) {
      res.status(404).json({ error: "Checklist item not found" });
      return;
    }

    const allItems = await db
      .select({ status: checklistItemsTable.status, required: checklistItemsTable.required })
      .from(checklistItemsTable)
      .where(eq(checklistItemsTable.runId, runId));

    const allDone = allItems.every(
      (i) => i.status === "completed" || i.status === "skipped",
    );

    if (allDone) {
      await db
        .update(checklistRunsTable)
        .set({ status: "completed", completedAt: new Date(), completedBy: authReq.userId })
        .where(eq(checklistRunsTable.id, runId));

      if (run.type === "offboarding") {
        await db
          .update(agentsTable)
          .set({ status: "offboarded" })
          .where(eq(agentsTable.id, run.agentId));

        await enqueue(JOB_NAMES.GENERATE_OFFBOARDING_PDF, {
          agentId: run.agentId,
          orgId: run.orgId,
          offboardDate: new Date().toISOString(),
        });
      }
    }

    res.json(item);
  },
);

export default router;
