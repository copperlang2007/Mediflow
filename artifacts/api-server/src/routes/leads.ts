import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  leadsTable,
  contactsTable,
  activitiesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router();

router.use(
  auditMiddleware("lead", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

const CreateLeadSchema = z.object({
  contactId: z.string(),
  source: z.string().max(100).optional().nullable(),
  sourceDetail: z.string().max(200).optional().nullable(),
  score: z.number().int().min(0).max(100).optional(),
  status: z.enum(["new", "contacted", "qualified", "disqualified", "converted"]).optional(),
  assignedAgentId: z.string().optional().nullable(),
});

const UpdateLeadSchema = z.object({
  source: z.string().max(100).optional().nullable(),
  sourceDetail: z.string().max(200).optional().nullable(),
  score: z.number().int().min(0).max(100).optional(),
  status: z.enum(["new", "contacted", "qualified", "disqualified", "converted"]).optional(),
  assignedAgentId: z.string().optional().nullable(),
});

// GET /leads
router.get(
  "/leads",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, assignedAgentId, limit, offset } = req.query as Record<string, string | undefined>;

    const conditions: SQL[] = [eq(leadsTable.orgId, authReq.orgId)];
    if (status && status !== "all") {
      conditions.push(eq(leadsTable.status, status as "new" | "contacted" | "qualified" | "disqualified" | "converted"));
    }
    if (assignedAgentId) {
      conditions.push(eq(leadsTable.assignedAgentId, assignedAgentId));
    }

    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);

    const [leads, totalRes] = await Promise.all([
      db
        .select({ lead: leadsTable, contact: contactsTable })
        .from(leadsTable)
        .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
        .where(and(...conditions))
        .orderBy(desc(leadsTable.createdAt))
        .limit(limitNum)
        .offset(offsetNum),
      db.select({ count: sql<number>`count(*)` }).from(leadsTable).where(and(...conditions)),
    ]);

    res.json({ data: leads, total: Number(totalRes[0]?.count ?? 0) });
  },
);

// POST /leads
router.post(
  "/leads",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateLeadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    // Verify contact belongs to org
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, parsed.data.contactId), eq(contactsTable.orgId, authReq.orgId))).limit(1);
    if (!contact) { res.status(400).json({ error: "Contact not found in this organisation" }); return; }

    const [lead] = await db.insert(leadsTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      contactId: parsed.data.contactId,
      source: parsed.data.source ?? null,
      sourceDetail: parsed.data.sourceDetail ?? null,
      score: parsed.data.score ?? 0,
      status: parsed.data.status ?? "new",
      assignedAgentId: parsed.data.assignedAgentId ?? null,
    }).returning();

    // Fire event-triggered automation rules for "lead_created"
    void enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId: authReq.orgId,
      trigger: "lead_created",
      resourceType: "lead",
      resourceId: lead.id,
      context: { contactId: parsed.data.contactId, source: parsed.data.source ?? null },
    });

    res.status(201).json(lead);
  },
);

// GET /leads/stats — MUST be registered before /leads/:id to prevent route shadowing
router.get(
  "/leads/stats",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const bySource = await db
      .select({ source: leadsTable.source, count: sql<number>`count(*)`, avgScore: sql<number>`avg(${leadsTable.score})` })
      .from(leadsTable)
      .where(eq(leadsTable.orgId, authReq.orgId))
      .groupBy(leadsTable.source);
    const byStatus = await db
      .select({ status: leadsTable.status, count: sql<number>`count(*)` })
      .from(leadsTable)
      .where(eq(leadsTable.orgId, authReq.orgId))
      .groupBy(leadsTable.status);
    res.json({ bySource, byStatus });
  },
);

// GET /leads/:id
router.get(
  "/leads/:id",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db
      .select({ lead: leadsTable, contact: contactsTable })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json(row);
  },
);

// PATCH /leads/:id
router.patch(
  "/leads/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

    const parsed = UpdateLeadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const d = parsed.data;

    const updates: Record<string, unknown> = {};
    if (d.source !== undefined) updates.source = d.source;
    if (d.sourceDetail !== undefined) updates.sourceDetail = d.sourceDetail;
    if (d.score !== undefined) updates.score = d.score;
    if (d.status !== undefined) updates.status = d.status;
    if (d.assignedAgentId !== undefined) updates.assignedAgentId = d.assignedAgentId;
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    const [existing2] = await db.select({ status: leadsTable.status }).from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
    const [updated] = await db.update(leadsTable).set(updates).where(eq(leadsTable.id, id)).returning();

    // Fire lead_status_changed automation hook when status changes
    if (d.status !== undefined && existing2 && d.status !== existing2.status) {
      void enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
        orgId: authReq.orgId,
        trigger: "lead_status_changed",
        resourceType: "lead",
        resourceId: id,
        context: { oldStatus: existing2.status, newStatus: d.status },
      });
    }

    res.json(updated);
  },
);

// POST /leads/:id/convert — convert lead to enrolled contact
router.post(
  "/leads/:id/convert",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db
      .select({ lead: leadsTable, contact: contactsTable })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "Lead not found" }); return; }
    if (row.lead.status === "converted") { res.status(409).json({ error: "Lead already converted" }); return; }

    // Mark lead as converted
    await db.update(leadsTable).set({ status: "converted", convertedAt: new Date() }).where(eq(leadsTable.id, id));
    // Update contact status to prospect/enrolled
    await db.update(contactsTable).set({ status: "prospect" }).where(eq(contactsTable.id, row.lead.contactId));
    // Log activity
    await db.insert(activitiesTable).values({ id: randomUUID(), orgId: authReq.orgId, contactId: row.lead.contactId, type: "status_change", body: "Lead converted to prospect", createdBy: authReq.userId });

    res.json({ success: true, contactId: row.lead.contactId });
  },
);

export default router;
