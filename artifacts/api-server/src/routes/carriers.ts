import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, carriersTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { seedDefaultCarriers } from "../lib/carrierSeed";

const router: IRouter = Router();

const CreateCarrierSchema = z.object({
  name: z.string().min(1).max(200),
  cmsContractNumber: z.string().max(50).optional(),
  logoUrl: z.string().url().optional(),
});

const UpdateCarrierSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cmsContractNumber: z.string().max(50).nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
});

router.use(
  auditMiddleware("agent", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

router.get(
  "/carriers",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const carriers = await db
      .select()
      .from(carriersTable)
      .where(eq(carriersTable.orgId, authReq.orgId))
      .orderBy(carriersTable.name);
    res.json(carriers);
  },
);

router.post(
  "/carriers/seed",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const seeded = await seedDefaultCarriers(authReq.orgId);

    const carriers = await db
      .select()
      .from(carriersTable)
      .where(eq(carriersTable.orgId, authReq.orgId))
      .orderBy(carriersTable.name);

    res.json({ seeded, carriers });
  },
);

router.post(
  "/carriers",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateCarrierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const [carrier] = await db
      .insert(carriersTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        name: parsed.data.name,
        cmsContractNumber: parsed.data.cmsContractNumber ?? null,
        logoUrl: parsed.data.logoUrl ?? null,
        isActive: true,
      })
      .returning();

    res.status(201).json(carrier);
  },
);

router.patch(
  "/carriers/:id",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const carrierId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdateCarrierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.cmsContractNumber !== undefined) updates.cmsContractNumber = data.cmsContractNumber;
    if (data.logoUrl !== undefined) updates.logoUrl = data.logoUrl;
    if (data.isActive !== undefined) updates.isActive = data.isActive;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [carrier] = await db
      .update(carriersTable)
      .set(updates)
      .where(and(eq(carriersTable.id, carrierId), eq(carriersTable.orgId, authReq.orgId)))
      .returning();

    if (!carrier) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    res.json(carrier);
  },
);

router.delete(
  "/carriers/:id",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const carrierId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [deleted] = await db
      .delete(carriersTable)
      .where(and(eq(carriersTable.id, carrierId), eq(carriersTable.orgId, authReq.orgId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
