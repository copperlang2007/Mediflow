import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, stateLicensesTable, licenseRenewalAlertsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router({ mergeParams: true });

const CreateLicenseSchema = z.object({
  stateCode: z.string().length(2).toUpperCase(),
  licenseType: z.string().min(1).max(100),
  licenseNumber: z.string().max(50).optional(),
  issueDate: z.string().optional(),
  expiryDate: z.string().optional(),
  status: z.enum(["active", "pending", "expired", "suspended", "not_appointed"]).default("pending"),
});

const UpdateLicenseSchema = z.object({
  stateCode: z.string().length(2).optional(),
  licenseType: z.string().min(1).max(100).optional(),
  licenseNumber: z.string().max(50).nullable().optional(),
  issueDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  status: z.enum(["active", "pending", "expired", "suspended", "not_appointed"]).optional(),
  renewalSubmittedAt: z.string().nullable().optional(),
  documentKey: z.string().nullable().optional(),
});

router.use(
  auditMiddleware("agent", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.lid ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

async function getAgentOrFail(
  agentId: string,
  orgId: string,
  res: Response,
): Promise<boolean> {
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
  "/agents/:id/licenses",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const { limit, offset } = req.query as {
      limit?: string;
      offset?: string;
    };

    // Bounded in practice (~50 US states per agent) but we still apply the
    // shared guard for consistency with other list endpoints. Per-route cap
    // of 200 leaves headroom for territories / multi-license-type rows.
    const limitNum = safeLimit(limit, 50, 200);
    const offsetNum = safeOffset(offset);

    const [licenses, totalRes] = await Promise.all([
      db
        .select()
        .from(stateLicensesTable)
        .where(eq(stateLicensesTable.agentId, agentId))
        .orderBy(stateLicensesTable.stateCode)
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(stateLicensesTable)
        .where(eq(stateLicensesTable.agentId, agentId)),
    ]);

    res.json({
      data: licenses,
      total: Number(totalRes[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
  },
);

router.post(
  "/agents/:id/licenses",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = CreateLicenseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { stateCode, licenseType, licenseNumber, issueDate, expiryDate, status } = parsed.data;

    const [license] = await db
      .insert(stateLicensesTable)
      .values({
        id: randomUUID(),
        agentId,
        stateCode,
        licenseType,
        licenseNumber: licenseNumber ?? null,
        issueDate: issueDate ? new Date(issueDate) : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        status,
      })
      .returning();

    res.status(201).json(license);
  },
);

router.patch(
  "/agents/:id/licenses/:lid",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const licenseId = Array.isArray(req.params.lid) ? req.params.lid[0] : req.params.lid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = UpdateLicenseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.stateCode !== undefined) updates.stateCode = data.stateCode.toUpperCase();
    if (data.licenseType !== undefined) updates.licenseType = data.licenseType;
    if (data.licenseNumber !== undefined) updates.licenseNumber = data.licenseNumber;
    if (data.issueDate !== undefined) updates.issueDate = data.issueDate ? new Date(data.issueDate) : null;
    if (data.expiryDate !== undefined) updates.expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
    if (data.status !== undefined) updates.status = data.status;
    if (data.renewalSubmittedAt !== undefined) updates.renewalSubmittedAt = data.renewalSubmittedAt ? new Date(data.renewalSubmittedAt) : null;
    if (data.documentKey !== undefined) updates.documentKey = data.documentKey;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [license] = await db
      .update(stateLicensesTable)
      .set(updates)
      .where(and(eq(stateLicensesTable.id, licenseId), eq(stateLicensesTable.agentId, agentId)))
      .returning();

    if (!license) {
      res.status(404).json({ error: "License not found" });
      return;
    }

    res.json(license);
  },
);

router.delete(
  "/agents/:id/licenses/:lid",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const licenseId = Array.isArray(req.params.lid) ? req.params.lid[0] : req.params.lid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const [deleted] = await db
      .delete(stateLicensesTable)
      .where(and(eq(stateLicensesTable.id, licenseId), eq(stateLicensesTable.agentId, agentId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "License not found" });
      return;
    }

    res.sendStatus(204);
  },
);

// GET /agents/:id/licenses/:lid/alerts — renewal alert history for one license
router.get(
  "/agents/:id/licenses/:lid/alerts",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const licenseId = Array.isArray(req.params.lid) ? req.params.lid[0] : req.params.lid;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    // Verify :lid belongs to this agent (prevents IDOR — alert metadata from another agent)
    const [license] = await db
      .select({ id: stateLicensesTable.id })
      .from(stateLicensesTable)
      .where(and(eq(stateLicensesTable.id, licenseId), eq(stateLicensesTable.agentId, agentId)))
      .limit(1);

    if (!license) {
      res.status(404).json({ error: "License not found" });
      return;
    }

    const alerts = await db
      .select()
      .from(licenseRenewalAlertsTable)
      .where(eq(licenseRenewalAlertsTable.licenseId, licenseId))
      .orderBy(licenseRenewalAlertsTable.alertDaysBefore);

    res.json(alerts);
  },
);

// POST /licenses/bulk-import — parse CSV body and upsert licenses for existing agents
const CsvLicenseRowSchema = z.object({
  agentId: z.string().min(1),
  stateCode: z.string().length(2).toUpperCase(),
  licenseType: z.string().min(1).max(100),
  licenseNumber: z.string().max(50).optional(),
  issueDate: z.string().optional(),
  expiryDate: z.string().optional(),
  status: z.enum(["active", "pending", "expired", "suspended", "not_appointed"]).default("pending"),
});

router.post(
  "/licenses/bulk-import",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { rows } = req.body as { rows?: unknown[] };

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: "rows must be a non-empty array" });
      return;
    }

    if (rows.length > 500) {
      res.status(400).json({ error: "Maximum 500 rows per import" });
      return;
    }

    const results: { imported: number; skipped: number; errors: string[] } = {
      imported: 0,
      skipped: 0,
      errors: [],
    };

    // Validate all org agents upfront
    const agentIds = [...new Set(rows.map((r: unknown) => (r as Record<string, unknown>).agentId as string))];
    const validAgents = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.orgId, authReq.orgId)));
    const validAgentIdSet = new Set(validAgents.map((a) => a.id));

    for (let i = 0; i < rows.length; i++) {
      const parsed = CsvLicenseRowSchema.safeParse(rows[i]);
      if (!parsed.success) {
        results.errors.push(`Row ${i + 1}: ${parsed.error.issues.map((e) => e.message).join(", ")}`);
        results.skipped++;
        continue;
      }
      const row = parsed.data;
      if (!validAgentIdSet.has(row.agentId)) {
        results.errors.push(`Row ${i + 1}: agentId ${row.agentId} not found in org`);
        results.skipped++;
        continue;
      }

      await db.insert(stateLicensesTable).values({
        id: randomUUID(),
        agentId: row.agentId,
        stateCode: row.stateCode,
        licenseType: row.licenseType,
        licenseNumber: row.licenseNumber ?? null,
        issueDate: row.issueDate ? new Date(row.issueDate) : null,
        expiryDate: row.expiryDate ? new Date(row.expiryDate) : null,
        status: row.status,
      }).onConflictDoNothing();

      results.imported++;
    }

    res.status(200).json(results);
    return;
  },
);

export default router;
