import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  automationRulesTable,
  automationRuleLogsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { enqueue, JOB_NAMES } from "../lib/jobs";

const router: IRouter = Router();

router.use(
  auditMiddleware("automation", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

const TRIGGER_TYPES = [
  "license_expires",
  "certification_expiring",
  "ahip_deadline",
  "lead_status_changed",
  "lead_created",
  "contact_created",
  "contact_status_changed",
  "contact_no_activity",
  "deal_stage_changed",
  "task_overdue",
  "enrollment_period_opens",
  "scheduled",
] as const;

const ACTION_TYPES = [
  "create_task",
  "send_notification",
  "send_email",
  "send_sms",
  "change_contact_status",
  "enroll_sequence",
  "change_deal_stage",
] as const;

const ConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "contains", "gt", "lt", "exists"]),
  value: z.unknown(),
  logic: z.enum(["and", "or"]).default("and"),
});

const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  config: z.record(z.unknown()),
});

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(200),
  triggerType: z.enum(TRIGGER_TYPES),
  triggerConfig: z.record(z.unknown()).optional().nullable(),
  conditions: z.array(ConditionSchema).optional().default([]),
  actions: z.array(ActionSchema).min(1),
  isActive: z.boolean().optional().default(true),
});

const UpdateRuleSchema = CreateRuleSchema.partial();

// GET /automations/rules
router.get(
  "/automations/rules",
  requireAuth,
  requirePermission("automation", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10) || 0;
    const triggerType = req.query.triggerType as string | undefined;
    const isActive = req.query.isActive as string | undefined;

    const conditions = [eq(automationRulesTable.orgId, authReq.orgId)];
    if (triggerType) conditions.push(eq(automationRulesTable.triggerType, triggerType));
    if (isActive !== undefined) conditions.push(eq(automationRulesTable.isActive, isActive === "true"));

    const [rules, countResult] = await Promise.all([
      db
        .select()
        .from(automationRulesTable)
        .where(and(...conditions))
        .orderBy(desc(automationRulesTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(automationRulesTable)
        .where(and(...conditions)),
    ]);

    res.json({ rules, total: Number(countResult[0]?.count ?? 0) });
  },
);

// POST /automations/rules
router.post(
  "/automations/rules",
  requireAuth,
  requirePermission("automation", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    const [rule] = await db.insert(automationRulesTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      name: parsed.data.name,
      triggerType: parsed.data.triggerType,
      triggerConfig: parsed.data.triggerConfig ?? null,
      conditions: parsed.data.conditions,
      actions: parsed.data.actions,
      isActive: parsed.data.isActive ?? true,
    }).returning();

    res.status(201).json(rule);
  },
);

// GET /automations/rules/:id
router.get(
  "/automations/rules/:id",
  requireAuth,
  requirePermission("automation", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [rule] = await db.select().from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!rule) { res.status(404).json({ error: "Automation rule not found" }); return; }
    res.json(rule);
  },
);

// PATCH /automations/rules/:id
router.patch(
  "/automations/rules/:id",
  requireAuth,
  requirePermission("automation", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: automationRulesTable.id }).from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Automation rule not found" }); return; }

    const parsed = UpdateRuleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.triggerType !== undefined) updates.triggerType = parsed.data.triggerType;
    if (parsed.data.triggerConfig !== undefined) updates.triggerConfig = parsed.data.triggerConfig;
    if (parsed.data.conditions !== undefined) updates.conditions = parsed.data.conditions;
    if (parsed.data.actions !== undefined) updates.actions = parsed.data.actions;
    if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;

    const [updated] = await db.update(automationRulesTable).set(updates).where(eq(automationRulesTable.id, id)).returning();
    res.json(updated);
  },
);

// DELETE /automations/rules/:id
router.delete(
  "/automations/rules/:id",
  requireAuth,
  requirePermission("automation", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: automationRulesTable.id }).from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Automation rule not found" }); return; }
    await db.delete(automationRulesTable).where(eq(automationRulesTable.id, id));
    res.status(204).send();
  },
);

// POST /automations/rules/:id/toggle — enable/disable without deletion
router.post(
  "/automations/rules/:id/toggle",
  requireAuth,
  requirePermission("automation", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select().from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Automation rule not found" }); return; }
    const [updated] = await db.update(automationRulesTable).set({ isActive: !existing.isActive }).where(eq(automationRulesTable.id, id)).returning();
    res.json(updated);
  },
);

// GET /automations/rules/:id/logs — execution history
router.get(
  "/automations/rules/:id/logs",
  requireAuth,
  requirePermission("automation", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [rule] = await db.select({ id: automationRulesTable.id }).from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!rule) { res.status(404).json({ error: "Automation rule not found" }); return; }

    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10) || 0;
    const result = req.query.result as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const conditions = [eq(automationRuleLogsTable.ruleId, id)];
    if (result) conditions.push(eq(automationRuleLogsTable.result, result as "success" | "partial" | "failed"));
    if (startDate) conditions.push(gte(automationRuleLogsTable.executedAt, new Date(startDate)));
    if (endDate) conditions.push(lte(automationRuleLogsTable.executedAt, new Date(endDate)));

    const logs = await db
      .select()
      .from(automationRuleLogsTable)
      .where(and(...conditions))
      .orderBy(desc(automationRuleLogsTable.executedAt))
      .limit(limit)
      .offset(offset);

    res.json(logs);
  },
);

// POST /automations/rules/:id/run — manual trigger
router.post(
  "/automations/rules/:id/run",
  requireAuth,
  requirePermission("automation", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [rule] = await db.select().from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!rule) { res.status(404).json({ error: "Automation rule not found" }); return; }

    const Schema = z.object({
      resourceType: z.string().optional().default("org"),
      resourceId: z.string().optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body" }); return; }

    await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId: authReq.orgId,
      trigger: rule.triggerType,
      resourceType: parsed.data.resourceType,
      resourceId: parsed.data.resourceId ?? authReq.orgId,
      context: { manualRun: true, ruleId: id },
    });

    res.json({ queued: true, ruleId: id });
  },
);

export default router;
