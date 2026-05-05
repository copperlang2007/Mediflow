import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, taskInstancesTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

const CreateTaskSchema = z.object({
  agentId: z.string().optional(),
  contactId: z.string().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  dueDate: z.string().optional(),
  assignedTo: z.string().optional(),
  assignedToUserId: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  templateId: z.string().optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  assignedToUserId: z.string().nullable().optional(),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
});

router.use(
  auditMiddleware("task_instance", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

router.get(
  "/tasks",
  requireAuth,
  requirePermission("task_instance", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, agentId, assignedToUserId, limit, offset } = req.query as {
      status?: string;
      agentId?: string;
      assignedToUserId?: string;
      limit?: string;
      offset?: string;
    };

    const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 200);
    const offsetNum = parseInt(offset ?? "0", 10) || 0;

    const conditions: SQL[] = [eq(taskInstancesTable.orgId, authReq.orgId)];
    if (status && ["open", "in_progress", "completed", "cancelled"].includes(status)) {
      conditions.push(eq(taskInstancesTable.status, status as "open" | "in_progress" | "completed" | "cancelled"));
    }
    if (agentId) conditions.push(eq(taskInstancesTable.agentId, agentId));
    if (assignedToUserId) conditions.push(eq(taskInstancesTable.assignedToUserId, assignedToUserId));

    const [tasks, totalResult] = await Promise.all([
      db
        .select()
        .from(taskInstancesTable)
        .where(and(...conditions))
        .orderBy(desc(taskInstancesTable.createdAt))
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(taskInstancesTable)
        .where(and(...conditions)),
    ]);

    res.json({ tasks, total: Number(totalResult[0]?.count ?? 0), limit: limitNum, offset: offsetNum });
  },
);

router.get(
  "/agents/:id/tasks",
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

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(and(eq(taskInstancesTable.agentId, agentId), eq(taskInstancesTable.orgId, authReq.orgId)))
      .orderBy(desc(taskInstancesTable.createdAt));

    res.json(tasks);
  },
);

router.post(
  "/tasks",
  requireAuth,
  requirePermission("task_instance", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const [task] = await db
      .insert(taskInstancesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        templateId: data.templateId ?? null,
        agentId: data.agentId ?? null,
        contactId: data.contactId ?? null,
        title: data.title,
        description: data.description ?? null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        assignedTo: data.assignedTo ?? null,
        assignedToUserId: data.assignedToUserId ?? null,
        priority: data.priority,
        status: "open",
        createdBy: authReq.userId,
      })
      .returning();

    res.status(201).json(task);
  },
);

router.patch(
  "/tasks/:id",
  requireAuth,
  requirePermission("task_instance", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.title !== undefined) updates.title = data.title;
    if (data.description !== undefined) updates.description = data.description;
    if (data.dueDate !== undefined) updates.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.assignedTo !== undefined) updates.assignedTo = data.assignedTo;
    if (data.assignedToUserId !== undefined) updates.assignedToUserId = data.assignedToUserId;
    if (data.status !== undefined) {
      updates.status = data.status;
      if (data.status === "completed") updates.completedAt = new Date();
    }
    if (data.priority !== undefined) updates.priority = data.priority;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [task] = await db
      .update(taskInstancesTable)
      .set(updates)
      .where(and(eq(taskInstancesTable.id, taskId), eq(taskInstancesTable.orgId, authReq.orgId)))
      .returning();

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json(task);
  },
);

router.delete(
  "/tasks/:id",
  requireAuth,
  requirePermission("task_instance", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [deleted] = await db
      .delete(taskInstancesTable)
      .where(and(eq(taskInstancesTable.id, taskId), eq(taskInstancesTable.orgId, authReq.orgId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
