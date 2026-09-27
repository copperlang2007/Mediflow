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
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import { seedDefaultCarriers } from "../lib/carrierSeed";

// TODO(day-6-followup): no dedicated frontend admin page exists for managing
// carriers today. The Day-6 email-out worker reads `appointment_desk_email`
// + `appointment_desk_metadata` directly from this table, and INSUREitALL
// configures these via the PATCH /carriers/:id route (CRUD-via-API). When a
// carrier-admin UI lands (settings → "Carriers"), surface a form field for
// the appointment-desk email + a small textarea for the metadata JSON.

const router: IRouter = Router();

// Loose jsonb shape: documented keys are `cc` (string[]) and `subject`
// (string); unknown keys pass through. We validate the documented keys when
// present so a typo doesn't silently disable the override, but we don't
// require either to keep the field optional.
const AppointmentDeskMetadataSchema = z
  .object({
    cc: z.array(z.string().email()).max(20).optional(),
    subject: z.string().max(300).optional(),
  })
  .catchall(z.unknown());

const CreateCarrierSchema = z.object({
  name: z.string().min(1).max(200),
  cmsContractNumber: z.string().max(50).optional(),
  logoUrl: z.string().url().optional(),
  appointmentDeskEmail: z.string().email().max(254).optional(),
  appointmentDeskMetadata: AppointmentDeskMetadataSchema.optional(),
});

const UpdateCarrierSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cmsContractNumber: z.string().max(50).nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  // Email-out worker (Day 6) reads this. `null` clears the configured
  // address (worker reverts to WARN-and-leave-open). String must be RFC-5322
  // valid for the worker to actually attempt delivery.
  appointmentDeskEmail: z.string().email().max(254).nullable().optional(),
  // jsonb override bag. We do not deep-validate unknown keys (forward-compat
  // by design) but we DO type-check the documented `cc` + `subject` keys
  // when present so a typo on those surfaces as a 400 rather than a silent
  // misconfiguration in production.
  appointmentDeskMetadata: AppointmentDeskMetadataSchema.optional(),
});

router.use(
  routerAuditMiddleware(router, "agent", undefined, {
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
        appointmentDeskEmail: parsed.data.appointmentDeskEmail ?? null,
        appointmentDeskMetadata: parsed.data.appointmentDeskMetadata ?? {},
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
    if (data.appointmentDeskEmail !== undefined)
      updates.appointmentDeskEmail = data.appointmentDeskEmail;
    if (data.appointmentDeskMetadata !== undefined)
      updates.appointmentDeskMetadata = data.appointmentDeskMetadata;

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
