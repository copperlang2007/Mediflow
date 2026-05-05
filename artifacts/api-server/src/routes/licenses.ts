import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, stateLicensesTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";

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

    const licenses = await db
      .select()
      .from(stateLicensesTable)
      .where(eq(stateLicensesTable.agentId, agentId))
      .orderBy(stateLicensesTable.stateCode);

    res.json(licenses);
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

export default router;
