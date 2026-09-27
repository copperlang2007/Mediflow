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
import { requireMfa } from "../middlewares/requireMfa";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";

import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router();

router.use(
  routerAuditMiddleware(router, "automation", undefined, {

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
  "contact_assigned",
  "contact_no_activity",
  "deal_stage_changed",
  "task_overdue",
  "task_completed",
  "enrollment_period_opens",
  "scheduled",
  "commission_received",
  "commission_missed",
  "chargeback_received",
] as const;

const ACTION_TYPES = [
  "create_task",
  "send_notification",
  "send_email",
  "send_sms",
  "change_contact_status",
  "enroll_sequence",
  "change_deal_stage",
  "create_appointment",
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
    const limit = safeLimit(req.query.limit, 50, 1000);
    const offset = safeOffset(req.query.offset);
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
  requireMfa,
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
  requireMfa,
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

    const [updated] = await db.update(automationRulesTable).set(updates).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).returning();
    res.json(updated);
  },
);

// DELETE /automations/rules/:id
router.delete(
  "/automations/rules/:id",
  requireAuth,
  requireMfa,
  requirePermission("automation", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: automationRulesTable.id }).from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Automation rule not found" }); return; }
    await db.delete(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId)));
    res.status(204).send();
  },
);

// POST /automations/rules/:id/toggle — enable/disable without deletion
router.post(
  "/automations/rules/:id/toggle",
  requireAuth,
  requireMfa,
  requirePermission("automation", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select().from(automationRulesTable).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Automation rule not found" }); return; }
    const [updated] = await db.update(automationRulesTable).set({ isActive: !existing.isActive }).where(and(eq(automationRulesTable.id, id), eq(automationRulesTable.orgId, authReq.orgId))).returning();
    res.json(updated);
  },
);

// GET /automations/recent-activity — org-wide recent rule runs
//
// Surfaces the last N execution log entries across every rule in the org so
// admins can quickly see what the engine is actually doing. Joined to
// automation_rules so each row carries the rule name + trigger type.
router.get(
  "/automations/recent-activity",
  requireAuth,
  requirePermission("automation", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const limit = safeLimit(req.query.limit, 30, 500);
    const result = req.query.result as string | undefined;

    const conditions = [eq(automationRulesTable.orgId, authReq.orgId)];
    if (result === "success" || result === "partial" || result === "failed") {
      conditions.push(eq(automationRuleLogsTable.result, result));
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [recent, totals] = await Promise.all([
      db
        .select({
          id: automationRuleLogsTable.id,
          ruleId: automationRuleLogsTable.ruleId,
          ruleName: automationRulesTable.name,
          triggerType: automationRulesTable.triggerType,
          triggerEvent: automationRuleLogsTable.triggerEvent,
          matchedRecordType: automationRuleLogsTable.matchedRecordType,
          matchedRecordId: automationRuleLogsTable.matchedRecordId,
          actionsExecuted: automationRuleLogsTable.actionsExecuted,
          result: automationRuleLogsTable.result,
          errorMessage: automationRuleLogsTable.errorMessage,
          executedAt: automationRuleLogsTable.executedAt,
        })
        .from(automationRuleLogsTable)
        .innerJoin(
          automationRulesTable,
          eq(automationRuleLogsTable.ruleId, automationRulesTable.id),
        )
        .where(and(...conditions))
        .orderBy(desc(automationRuleLogsTable.executedAt))
        .limit(limit),
      db
        .select({
          result: automationRuleLogsTable.result,
          count: sql<number>`count(*)`,
        })
        .from(automationRuleLogsTable)
        .innerJoin(
          automationRulesTable,
          eq(automationRuleLogsTable.ruleId, automationRulesTable.id),
        )
        .where(
          and(
            eq(automationRulesTable.orgId, authReq.orgId),
            gte(automationRuleLogsTable.executedAt, since24h),
          ),
        )
        .groupBy(automationRuleLogsTable.result),
    ]);

    const last24h = { success: 0, partial: 0, failed: 0 };
    for (const row of totals) {
      if (row.result in last24h) {
        last24h[row.result as keyof typeof last24h] = Number(row.count);
      }
    }

    res.json({
      recent,
      last24h,
      total: recent.length,
    });
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

    const limit = safeLimit(req.query.limit, 50, 500);
    const offset = safeOffset(req.query.offset);
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
  requireMfa,
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
