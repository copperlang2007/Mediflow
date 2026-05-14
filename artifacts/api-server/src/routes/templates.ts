import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, ilike, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  emailTemplatesTable,
  smsTemplatesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

// ---- SMS Templates ----

router.get(
  "/sms-templates",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { category, search } = req.query as Record<string, string | undefined>;
    const conditions: SQL[] = [eq(smsTemplatesTable.orgId, authReq.orgId)];
    if (category) conditions.push(eq(smsTemplatesTable.category, category));
    if (search) conditions.push(ilike(smsTemplatesTable.name, `%${search}%`));
    const templates = await db.select().from(smsTemplatesTable).where(and(...conditions)).orderBy(desc(smsTemplatesTable.updatedAt));
    res.json(templates);
  },
);

router.post(
  "/sms-templates",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const Schema = z.object({
      name: z.string().min(1).max(200),
      body: z.string().min(1).max(1600),
      category: z.string().max(50).optional(),
      mergeFields: z.string().array().optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [tpl] = await db.insert(smsTemplatesTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      name: parsed.data.name,
      body: parsed.data.body,
      category: parsed.data.category ?? "general",
      mergeFields: parsed.data.mergeFields ?? [],
    }).returning();
    res.status(201).json(tpl);
  },
);

router.get(
  "/sms-templates/:id",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [tpl] = await db.select().from(smsTemplatesTable).where(and(eq(smsTemplatesTable.id, id), eq(smsTemplatesTable.orgId, authReq.orgId))).limit(1);
    if (!tpl) { res.status(404).json({ error: "SMS template not found" }); return; }
    res.json(tpl);
  },
);

router.patch(
  "/sms-templates/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: smsTemplatesTable.id }).from(smsTemplatesTable).where(and(eq(smsTemplatesTable.id, id), eq(smsTemplatesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "SMS template not found" }); return; }
    const Schema = z.object({ name: z.string().min(1).max(200).optional(), body: z.string().min(1).max(1600).optional(), category: z.string().max(50).optional(), mergeFields: z.string().array().optional() });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [updated] = await db.update(smsTemplatesTable).set({ ...parsed.data }).where(and(eq(smsTemplatesTable.id, id), eq(smsTemplatesTable.orgId, authReq.orgId))).returning();
    res.json(updated);
  },
);

router.delete(
  "/sms-templates/:id",
  requireAuth,
  requirePermission("contact", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: smsTemplatesTable.id }).from(smsTemplatesTable).where(and(eq(smsTemplatesTable.id, id), eq(smsTemplatesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "SMS template not found" }); return; }
    await db.delete(smsTemplatesTable).where(and(eq(smsTemplatesTable.id, id), eq(smsTemplatesTable.orgId, authReq.orgId)));
    res.status(204).send();
  },
);

// ---- Email Templates ----

router.get(
  "/email-templates",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { category, search } = req.query as Record<string, string | undefined>;
    const conditions: SQL[] = [eq(emailTemplatesTable.orgId, authReq.orgId)];
    if (category) conditions.push(eq(emailTemplatesTable.category, category));
    if (search) conditions.push(ilike(emailTemplatesTable.name, `%${search}%`));
    const templates = await db.select().from(emailTemplatesTable).where(and(...conditions)).orderBy(desc(emailTemplatesTable.updatedAt));
    res.json(templates);
  },
);

router.post(
  "/email-templates",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const Schema = z.object({
      name: z.string().min(1).max(200),
      subject: z.string().min(1).max(500),
      bodyHtml: z.string().min(1),
      bodyText: z.string().optional(),
      category: z.string().max(50).optional(),
      mergeFields: z.string().array().optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [tpl] = await db.insert(emailTemplatesTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      name: parsed.data.name,
      subject: parsed.data.subject,
      bodyHtml: parsed.data.bodyHtml,
      bodyText: parsed.data.bodyText ?? null,
      category: parsed.data.category ?? "general",
      mergeFields: parsed.data.mergeFields ?? [],
    }).returning();
    res.status(201).json(tpl);
  },
);

router.get(
  "/email-templates/:id",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [tpl] = await db.select().from(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, id), eq(emailTemplatesTable.orgId, authReq.orgId))).limit(1);
    if (!tpl) { res.status(404).json({ error: "Email template not found" }); return; }
    res.json(tpl);
  },
);

router.patch(
  "/email-templates/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: emailTemplatesTable.id }).from(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, id), eq(emailTemplatesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Email template not found" }); return; }
    const Schema = z.object({ name: z.string().min(1).max(200).optional(), subject: z.string().min(1).max(500).optional(), bodyHtml: z.string().min(1).optional(), bodyText: z.string().nullable().optional(), category: z.string().max(50).optional(), mergeFields: z.string().array().optional() });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [updated] = await db.update(emailTemplatesTable).set({ ...parsed.data }).where(and(eq(emailTemplatesTable.id, id), eq(emailTemplatesTable.orgId, authReq.orgId))).returning();
    res.json(updated);
  },
);

router.delete(
  "/email-templates/:id",
  requireAuth,
  requirePermission("contact", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: emailTemplatesTable.id }).from(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, id), eq(emailTemplatesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Email template not found" }); return; }
    await db.delete(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, id), eq(emailTemplatesTable.orgId, authReq.orgId)));
    res.status(204).send();
  },
);

// ---- Template preview with merge field substitution ----
router.post(
  "/templates/preview",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const Schema = z.object({
      body: z.string(),
      sampleData: z.record(z.string()).optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const defaults: Record<string, string> = {
      first_name: "Jane",
      last_name: "Smith",
      agent_name: "John Agent",
      plan_type: "MAPD",
      carrier: "United Healthcare",
      plan_year: String(new Date().getFullYear()),
      aep_start_date: "Oct 15",
      phone: "555-0100",
      email: "jane@example.com",
    };
    const data = { ...defaults, ...(parsed.data.sampleData ?? {}) };
    let preview = parsed.data.body;
    for (const [key, value] of Object.entries(data)) {
      preview = preview.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    res.json({ preview });
  },
);

export default router;
