import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, orgSettingsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

const UpdateSettingsSchema = z.object({
  ahipSeasonOpenMonth: z.number().int().min(1).max(12).optional(),
  ahipSeasonOpenDay: z.number().int().min(1).max(31).optional(),
  ahipDeadlineMonth: z.number().int().min(1).max(12).optional(),
  ahipDeadlineDay: z.number().int().min(1).max(31).optional(),
  ahipReminderEnabled: z.boolean().optional(),
  ahipReminderIntervalWeeks: z.number().int().min(1).max(52).optional(),
});

router.get(
  "/org-settings",
  requireAuth,
  requirePermission("org", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const [settings] = await db
      .select()
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.orgId, authReq.orgId))
      .limit(1);

    if (!settings) {
      res.json({
        id: null,
        orgId: authReq.orgId,
        ahipSeasonOpenMonth: 7,
        ahipSeasonOpenDay: 1,
        ahipDeadlineMonth: 12,
        ahipDeadlineDay: 7,
        ahipReminderEnabled: true,
        ahipReminderIntervalWeeks: 2,
      });
      return;
    }

    res.json(settings);
  },
);

router.put(
  "/org-settings",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;

    const [existing] = await db
      .select({ id: orgSettingsTable.id })
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.orgId, authReq.orgId))
      .limit(1);

    if (!existing) {
      const [settings] = await db
        .insert(orgSettingsTable)
        .values({
          id: randomUUID(),
          orgId: authReq.orgId,
          ahipSeasonOpenMonth: data.ahipSeasonOpenMonth ?? 7,
          ahipSeasonOpenDay: data.ahipSeasonOpenDay ?? 1,
          ahipDeadlineMonth: data.ahipDeadlineMonth ?? 12,
          ahipDeadlineDay: data.ahipDeadlineDay ?? 7,
          ahipReminderEnabled: data.ahipReminderEnabled ?? true,
          ahipReminderIntervalWeeks: data.ahipReminderIntervalWeeks ?? 2,
        })
        .returning();
      res.json(settings);
    } else {
      const updates: Record<string, unknown> = {};
      if (data.ahipSeasonOpenMonth !== undefined) updates.ahipSeasonOpenMonth = data.ahipSeasonOpenMonth;
      if (data.ahipSeasonOpenDay !== undefined) updates.ahipSeasonOpenDay = data.ahipSeasonOpenDay;
      if (data.ahipDeadlineMonth !== undefined) updates.ahipDeadlineMonth = data.ahipDeadlineMonth;
      if (data.ahipDeadlineDay !== undefined) updates.ahipDeadlineDay = data.ahipDeadlineDay;
      if (data.ahipReminderEnabled !== undefined) updates.ahipReminderEnabled = data.ahipReminderEnabled;
      if (data.ahipReminderIntervalWeeks !== undefined) updates.ahipReminderIntervalWeeks = data.ahipReminderIntervalWeeks;

      const [settings] = await db
        .update(orgSettingsTable)
        .set(updates)
        .where(eq(orgSettingsTable.orgId, authReq.orgId))
        .returning();
      res.json(settings);
    }
  },
);

export default router;
