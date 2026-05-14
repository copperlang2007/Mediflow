import { Router, type IRouter, type Request, type Response } from "express";
import { eq, ne, and, sql, desc, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, taskInstancesTable, taskTemplatesTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

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

    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);

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

    // Match the per-route ceiling used by the sibling /users and
    // /agents/:id/licenses endpoints (PR #70): default 50, hard cap 200.
    // High-volume agents could otherwise return thousands of historical task
    // rows in a single response.
    const limitNum = safeLimit(req.query.limit, 50, 200);
    const offsetNum = safeOffset(req.query.offset);

    const whereClause = and(
      eq(taskInstancesTable.agentId, agentId),
      eq(taskInstancesTable.orgId, authReq.orgId),
    );

    const [tasks, totalRes] = await Promise.all([
      db
        .select()
        .from(taskInstancesTable)
        .where(whereClause)
        .orderBy(desc(taskInstancesTable.createdAt))
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(taskInstancesTable)
        .where(whereClause),
    ]);

    res.json({
      data: tasks,
      total: Number(totalRes[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
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

    // Validate agentId belongs to the caller's org to prevent cross-org FK associations
    if (data.agentId) {
      const [agt] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(and(eq(agentsTable.id, data.agentId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!agt) {
        res.status(400).json({ error: "agentId does not belong to this organisation" });
        return;
      }
    }

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

// PATCH /tasks/:id
//
// Concurrency note: the previous handler unconditionally wrote
// `completedAt = now()` whenever `status: "completed"` was in the
// payload and unconditionally fired `task_completed` — regardless of
// whether the task was already completed. Two concurrent "complete this
// task" PATCHes would both overwrite `completedAt` and BOTH fire the
// trigger, doubling any downstream automation side effects.
//
// The fix performs the completion via a conditional UPDATE gated on
// `status != "completed"`. Only the caller whose UPDATE actually
// transitioned the row sees a non-empty `returning()` and only that
// caller fires the trigger. Same-completion no-ops return 200 with the
// current task row (idempotent contract preserved) and a stable
// `completedAt`.
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
    if (data.priority !== undefined) updates.priority = data.priority;
    if (data.status !== undefined && data.status !== "completed") {
      updates.status = data.status;
    }

    if (Object.keys(updates).length === 0 && data.status !== "completed") {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      let transitionedToCompleted = false;
      let row: typeof taskInstancesTable.$inferSelect | undefined;

      if (data.status === "completed") {
        // Conditional UPDATE — only callers that actually transition the
        // task from non-completed to completed see a returned row.
        const [updated] = await tx
          .update(taskInstancesTable)
          .set({ ...updates, status: "completed", completedAt: new Date() })
          .where(
            and(
              eq(taskInstancesTable.id, taskId),
              eq(taskInstancesTable.orgId, authReq.orgId),
              ne(taskInstancesTable.status, "completed"),
            ),
          )
          .returning();

        if (updated) {
          transitionedToCompleted = true;
          row = updated;
        } else {
          // Either the task doesn't exist (-> 404) or it's already
          // completed (-> 200 idempotent). Disambiguate. Don't bump
          // `completedAt` and don't fire the trigger.
          const [existing] = await tx
            .select()
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.id, taskId), eq(taskInstancesTable.orgId, authReq.orgId)))
            .limit(1);
          if (!existing) {
            return { kind: "not-found" as const };
          }
          // Still apply any non-status fields the caller bundled in.
          if (Object.keys(updates).length > 0) {
            const [updated2] = await tx
              .update(taskInstancesTable)
              .set(updates)
              .where(and(eq(taskInstancesTable.id, taskId), eq(taskInstancesTable.orgId, authReq.orgId)))
              .returning();
            row = updated2;
          } else {
            row = existing;
          }
        }
      } else {
        const [updated] = await tx
          .update(taskInstancesTable)
          .set(updates)
          .where(and(eq(taskInstancesTable.id, taskId), eq(taskInstancesTable.orgId, authReq.orgId)))
          .returning();
        if (!updated) {
          return { kind: "not-found" as const };
        }
        row = updated;
      }

      return { kind: "ok" as const, row, transitionedToCompleted };
    });

    if (result.kind === "not-found") {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const task = result.row;
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Fire `task_completed` automation trigger ONLY when the conditional
    // UPDATE actually transitioned the task to completed.
    if (result.transitionedToCompleted) {
      enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
        orgId: authReq.orgId,
        trigger: "task_completed",
        resourceType: "task",
        resourceId: task.id,
        context: {
          taskTitle: task.title,
          agentId: task.agentId ?? null,
          contactId: task.contactId ?? null,
          templateId: task.templateId ?? null,
          completedBy: authReq.userId,
        },
      }).catch((err) => {
        logger.warn(
          {
            err,
            jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
            trigger: "task_completed",
            orgId: authReq.orgId,
            taskId: task.id,
            contactId: task.contactId ?? null,
          },
          "Failed to enqueue automation job",
        );
        captureWorkerError(err, {
          worker: "tasks",
          route: "PATCH /tasks/:id",
          jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
          trigger: "task_completed",
          orgId: authReq.orgId,
          taskId: task.id,
        });
      });
    }

    res.json(task);
  },
);

// POST /tasks/bulk-from-template — assign one task per agent using a template
const BulkFromTemplateSchema = z.object({
  templateId: z.string().min(1),
  agentIds: z.array(z.string().min(1)).min(1).max(500),
  dueDate: z.string().optional(),
});

router.post(
  "/tasks/bulk-from-template",
  requireAuth,
  requirePermission("task_instance", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = BulkFromTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { templateId, agentIds, dueDate } = parsed.data;

    const [template] = await db
      .select()
      .from(taskTemplatesTable)
      .where(
        and(
          eq(taskTemplatesTable.id, templateId),
          eq(taskTemplatesTable.orgId, authReq.orgId),
          eq(taskTemplatesTable.isActive, true),
        ),
      )
      .limit(1);

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const uniqueAgentIds = Array.from(new Set(agentIds));

    // Validate every agent belongs to this org. Filter to avoid cross-org FK
    // associations. If any input ID is missing from this set, it's silently
    // skipped (and returned as `skipped`).
    const validAgents = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.orgId, authReq.orgId),
          inArray(agentsTable.id, uniqueAgentIds),
        ),
      );

    const validIds = new Set(validAgents.map((a) => a.id));
    const skipped = uniqueAgentIds.filter((id) => !validIds.has(id));

    if (validIds.size === 0) {
      res.status(400).json({
        error: "No valid agents in this organisation for the supplied IDs",
        skipped,
      });
      return;
    }

    // Compute the per-task due date once. Explicit dueDate overrides the
    // template's dueDaysFromTrigger offset (relative to "now").
    let computedDue: Date | null = null;
    if (dueDate) {
      computedDue = new Date(dueDate);
    } else if (template.dueDaysFromTrigger != null) {
      computedDue = new Date(
        Date.now() + template.dueDaysFromTrigger * 86_400_000,
      );
    }

    const now = new Date();
    const rows = Array.from(validIds).map((agentId) => ({
      id: randomUUID(),
      orgId: authReq.orgId,
      templateId: template.id,
      agentId,
      contactId: null,
      title: template.title || template.name,
      description: template.description ?? null,
      dueDate: computedDue,
      assignedTo: null,
      assignedToUserId: null,
      priority: template.priority,
      status: "open" as const,
      createdBy: authReq.userId,
      createdAt: now,
      updatedAt: now,
    }));

    const created = await db.insert(taskInstancesTable).values(rows).returning();

    res.status(201).json({
      created: created.length,
      skipped,
      tasks: created,
    });
  },
);

router.delete(
  "/tasks/:id",
  requireAuth,
  requirePermission("task_instance", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [cancelled] = await db
      .update(taskInstancesTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(taskInstancesTable.id, taskId), eq(taskInstancesTable.orgId, authReq.orgId)))
      .returning();

    if (!cancelled) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.sendStatus(204);
  },
);

// =====================================================================
// Task Template CRUD — admin management of reusable task templates
// =====================================================================

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  type: z.string().default("custom"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  triggerEvent: z.string().optional(),
  dueDaysFromTrigger: z.number().int().min(1).optional(),
  steps: z.array(z.record(z.unknown())).optional(),
});

const UpdateTemplateSchema = CreateTemplateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

router.get(
  "/task-templates",
  requireAuth,
  requirePermission("task_instance", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const templates = await db
      .select()
      .from(taskTemplatesTable)
      .where(and(eq(taskTemplatesTable.orgId, authReq.orgId), eq(taskTemplatesTable.isActive, true)))
      .orderBy(taskTemplatesTable.name);

    res.json(templates);
  },
);

router.post(
  "/task-templates",
  requireAuth,
  requirePermission("task_instance", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const [template] = await db
      .insert(taskTemplatesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        name: parsed.data.name,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        type: parsed.data.type,
        priority: parsed.data.priority,
        triggerEvent: parsed.data.triggerEvent ?? null,
        dueDaysFromTrigger: parsed.data.dueDaysFromTrigger ?? null,
        steps: parsed.data.steps ?? null,
        isActive: true,
      })
      .returning();

    res.status(201).json(template);
  },
);

router.patch(
  "/task-templates/:id",
  requireAuth,
  requirePermission("task_instance", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const templateId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const updates: Record<string, unknown> = {};
    const d = parsed.data;
    if (d.name !== undefined) updates.name = d.name;
    if (d.title !== undefined) updates.title = d.title;
    if (d.description !== undefined) updates.description = d.description;
    if (d.type !== undefined) updates.type = d.type;
    if (d.priority !== undefined) updates.priority = d.priority;
    if (d.triggerEvent !== undefined) updates.triggerEvent = d.triggerEvent;
    if (d.dueDaysFromTrigger !== undefined) updates.dueDaysFromTrigger = d.dueDaysFromTrigger;
    if (d.steps !== undefined) updates.steps = d.steps;
    if (d.isActive !== undefined) updates.isActive = d.isActive;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [template] = await db
      .update(taskTemplatesTable)
      .set(updates)
      .where(and(eq(taskTemplatesTable.id, templateId), eq(taskTemplatesTable.orgId, authReq.orgId)))
      .returning();

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(template);
  },
);

router.delete(
  "/task-templates/:id",
  requireAuth,
  requirePermission("task_instance", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const templateId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [template] = await db
      .update(taskTemplatesTable)
      .set({ isActive: false })
      .where(and(eq(taskTemplatesTable.id, templateId), eq(taskTemplatesTable.orgId, authReq.orgId)))
      .returning();

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
