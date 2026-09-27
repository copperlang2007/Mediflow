import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import {
  db,
  agentsTable,
  techStackAccountsTable,
  platformRequirementsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware, scopeToRouter } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

const CreateAccountSchema = z.object({
  platformName: z.string().min(1).max(200),
  platformCategory: z.string().max(100).optional(),
  status: z.enum(["provisioned", "pending", "deprovisioned"]).default("pending"),
  accountIdentifier: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});

const UpdateAccountSchema = z.object({
  status: z.enum(["provisioned", "pending", "deprovisioned"]).optional(),
  accountIdentifier: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const BulkUpdateAccountSchema = z.object({
  accountIds: z.array(z.string()).min(1).max(100),
  status: z.enum(["provisioned", "pending", "deprovisioned"]),
  notes: z.string().max(1000).optional(),
});

const CreatePlatformReqSchema = z.object({
  platformName: z.string().min(1).max(200),
  platformCategory: z.string().max(100).optional(),
  isRequired: z.boolean().default(true),
  onboardingOrder: z.number().int().min(0).default(0),
  requiredForRole: z.string().max(100).nullable().optional(),
});

const UpdatePlatformReqSchema = z.object({
  platformName: z.string().min(1).max(200).optional(),
  platformCategory: z.string().max(100).nullable().optional(),
  isRequired: z.boolean().optional(),
  onboardingOrder: z.number().int().min(0).optional(),
  requiredForRole: z.string().max(100).nullable().optional(),
});

router.use(
  scopeToRouter(router, auditMiddleware("agent", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.aid ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  })),
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
  "/agents/:id/tech-stack",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const accounts = await db
      .select()
      .from(techStackAccountsTable)
      .where(eq(techStackAccountsTable.agentId, agentId))
      .orderBy(techStackAccountsTable.platformName);

    res.json(accounts);
  },
);

router.post(
  "/agents/:id/tech-stack",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = CreateAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const [account] = await db
      .insert(techStackAccountsTable)
      .values({
        id: randomUUID(),
        agentId,
        platformName: data.platformName,
        platformCategory: data.platformCategory ?? null,
        status: data.status,
        accountIdentifier: data.accountIdentifier ?? null,
        notes: data.notes ?? null,
        provisionedAt: data.status === "provisioned" ? new Date() : null,
      })
      .returning();

    res.status(201).json(account);
  },
);

router.patch(
  "/agents/:id/tech-stack/bulk",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = BulkUpdateAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { accountIds, status, notes } = parsed.data;
    const updates: Record<string, unknown> = { status };
    if (status === "provisioned") updates.provisionedAt = new Date();
    if (status === "deprovisioned") updates.deprovisionedAt = new Date();
    if (notes !== undefined) updates.notes = notes;

    await db
      .update(techStackAccountsTable)
      .set(updates)
      .where(
        and(
          eq(techStackAccountsTable.agentId, agentId),
          inArray(techStackAccountsTable.id, accountIds),
        ),
      );

    const updated = await db
      .select()
      .from(techStackAccountsTable)
      .where(eq(techStackAccountsTable.agentId, agentId))
      .orderBy(techStackAccountsTable.platformName);

    res.json({ updated });
  },
);

router.get(
  "/agents/:id/tech-stack/pdf",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const accounts = await db
      .select()
      .from(techStackAccountsTable)
      .where(eq(techStackAccountsTable.agentId, agentId))
      .orderBy(techStackAccountsTable.platformName);

    const requirements = await db
      .select()
      .from(platformRequirementsTable)
      .where(eq(platformRequirementsTable.orgId, authReq.orgId))
      .orderBy(platformRequirementsTable.onboardingOrder);

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "LETTER" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const NAVY = "#1a365d";
      const BLUE = "#2b4c7e";
      const TEXT = "#111111";
      const BORDER = "#cccccc";
      const LIGHT_GREY = "#f5f5f5";

      doc.rect(0, 0, doc.page.width, 72).fill(NAVY);
      doc.fillColor("#ffffff").fontSize(20).font("Helvetica-Bold")
        .text("Tech Stack Status Report", 50, 22);
      doc.fontSize(9).font("Helvetica")
        .text(`Agent: ${agent.firstName} ${agent.lastName}  |  Generated: ${new Date().toISOString().slice(0, 10)}`, 50, 50);
      doc.fillColor(TEXT);
      doc.y = 90;

      const summaryProvisioned = accounts.filter((a) => a.status === "provisioned").length;
      const summaryPending = accounts.filter((a) => a.status === "pending").length;
      const summaryDeprov = accounts.filter((a) => a.status === "deprovisioned").length;

      doc.rect(50, doc.y, doc.page.width - 100, 18).fill(BLUE);
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
        .text("Summary", 56, doc.y - 15, { lineBreak: false });
      doc.fillColor(TEXT).moveDown(0.4);

      const summaryY = doc.y;
      doc.fontSize(9).font("Helvetica").text(`Total Platforms: ${accounts.length}`, 56, summaryY);
      doc.text(`Provisioned: ${summaryProvisioned}`, 56, summaryY + 14);
      doc.text(`Pending: ${summaryPending}`, 56, summaryY + 28);
      doc.text(`Deprovisioned: ${summaryDeprov}`, 56, summaryY + 42);
      doc.y = summaryY + 60;

      doc.rect(50, doc.y, doc.page.width - 100, 18).fill(BLUE);
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
        .text(`Platform Accounts (${accounts.length})`, 56, doc.y - 15, { lineBreak: false });
      doc.fillColor(TEXT).moveDown(0.4);

      const colWidths = [160, 100, 90, 90, 80];
      const headers = ["Platform", "Category", "Status", "Provisioned", "Identifier"];
      const left = 50;
      const rowH = 16;
      let y = doc.y + 4;

      doc.rect(left, y, doc.page.width - 100, rowH).fill(LIGHT_GREY);
      doc.rect(left, y, doc.page.width - 100, rowH).stroke(BORDER);
      let x = left;
      headers.forEach((h, i) => {
        doc.fillColor(TEXT).fontSize(8).font("Helvetica-Bold")
          .text(h, x + 3, y + 4, { width: colWidths[i]! - 6, lineBreak: false });
        x += colWidths[i]!;
      });
      y += rowH;

      accounts.forEach((acct, ri) => {
        if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 60; }
        if (ri % 2 === 0) doc.rect(left, y, doc.page.width - 100, rowH).fillAndStroke("#fafafa", BORDER);
        else doc.rect(left, y, doc.page.width - 100, rowH).stroke(BORDER);
        x = left;
        const cells = [
          acct.platformName,
          acct.platformCategory ?? "—",
          acct.status,
          acct.provisionedAt ? new Date(acct.provisionedAt).toISOString().slice(0, 10) : "—",
          acct.accountIdentifier ?? "—",
        ];
        cells.forEach((cell, i) => {
          doc.fillColor(TEXT).fontSize(8).font("Helvetica")
            .text(String(cell), x + 3, y + 4, { width: colWidths[i]! - 6, lineBreak: false });
          x += colWidths[i]!;
        });
        y += rowH;
      });
      doc.y = y + 6;

      if (requirements.length > 0) {
        doc.moveDown(0.6);
        doc.rect(50, doc.y, doc.page.width - 100, 18).fill(BLUE);
        doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
          .text(`Required Platforms (${requirements.length})`, 56, doc.y - 15, { lineBreak: false });
        doc.fillColor(TEXT).moveDown(0.4);

        requirements.forEach((req_, ri) => {
          const accountMatch = accounts.find((a) => a.platformName === req_.platformName);
          const status = accountMatch?.status ?? "not configured";
          const reqY = doc.y;
          if (ri % 2 === 0) doc.rect(50, reqY - 1, doc.page.width - 100, 14).fill("#fafafa");
          doc.fillColor(TEXT).fontSize(8).font("Helvetica")
            .text(`${req_.platformName}${req_.requiredForRole ? ` (${req_.requiredForRole})` : ""}`, 56, reqY, { width: 250, lineBreak: false });
          doc.text(status, 320, reqY, { width: 100, lineBreak: false });
          doc.moveDown(0.3);
        });
      }

      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(8).fillColor("#888888").font("Helvetica")
          .text(`agencyBRIDGE — Confidential  |  Page ${i + 1} of ${pages.count}`, 50,
            doc.page.height - 35, { align: "center", width: doc.page.width - 100 });
      }

      doc.end();
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tech-stack-${agent.firstName}-${agent.lastName}.pdf"`,
    );
    res.send(buffer);
  },
);

router.patch(
  "/agents/:id/tech-stack/:aid",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const accountId = Array.isArray(req.params.aid) ? req.params.aid[0] : req.params.aid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = UpdateAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.status !== undefined) {
      updates.status = data.status;
      if (data.status === "provisioned") updates.provisionedAt = new Date();
      if (data.status === "deprovisioned") updates.deprovisionedAt = new Date();
    }
    if (data.accountIdentifier !== undefined) updates.accountIdentifier = data.accountIdentifier;
    if (data.notes !== undefined) updates.notes = data.notes;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [account] = await db
      .update(techStackAccountsTable)
      .set(updates)
      .where(and(eq(techStackAccountsTable.id, accountId), eq(techStackAccountsTable.agentId, agentId)))
      .returning();

    if (!account) {
      res.status(404).json({ error: "Tech stack account not found" });
      return;
    }

    res.json(account);
  },
);

router.get(
  "/platform-requirements",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const reqs = await db
      .select()
      .from(platformRequirementsTable)
      .where(eq(platformRequirementsTable.orgId, authReq.orgId))
      .orderBy(platformRequirementsTable.onboardingOrder);
    res.json(reqs);
  },
);

router.post(
  "/platform-requirements",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreatePlatformReqSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const [req_] = await db
      .insert(platformRequirementsTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        platformName: parsed.data.platformName,
        platformCategory: parsed.data.platformCategory ?? null,
        isRequired: parsed.data.isRequired,
        onboardingOrder: parsed.data.onboardingOrder,
        requiredForRole: parsed.data.requiredForRole ?? null,
      })
      .returning();

    res.status(201).json(req_);
  },
);

router.patch(
  "/platform-requirements/:id",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const reqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdatePlatformReqSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.platformName !== undefined) updates.platformName = data.platformName;
    if (data.platformCategory !== undefined) updates.platformCategory = data.platformCategory;
    if (data.isRequired !== undefined) updates.isRequired = data.isRequired;
    if (data.onboardingOrder !== undefined) updates.onboardingOrder = data.onboardingOrder;
    if (data.requiredForRole !== undefined) updates.requiredForRole = data.requiredForRole;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [updated] = await db
      .update(platformRequirementsTable)
      .set(updates)
      .where(and(eq(platformRequirementsTable.id, reqId), eq(platformRequirementsTable.orgId, authReq.orgId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Platform requirement not found" });
      return;
    }

    res.json(updated);
  },
);

router.delete(
  "/platform-requirements/:id",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const reqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [deleted] = await db
      .delete(platformRequirementsTable)
      .where(and(eq(platformRequirementsTable.id, reqId), eq(platformRequirementsTable.orgId, authReq.orgId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Platform requirement not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
