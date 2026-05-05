import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
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
import { auditMiddleware } from "../middlewares/auditMiddleware";

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

const CreatePlatformReqSchema = z.object({
  platformName: z.string().min(1).max(200),
  platformCategory: z.string().max(100).optional(),
  isRequired: z.boolean().default(true),
  onboardingOrder: z.number().int().min(0).default(0),
});

const UpdatePlatformReqSchema = z.object({
  platformName: z.string().min(1).max(200).optional(),
  platformCategory: z.string().max(100).nullable().optional(),
  isRequired: z.boolean().optional(),
  onboardingOrder: z.number().int().min(0).optional(),
});

router.use(
  auditMiddleware("agent", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.aid ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
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
