import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, orgSettingsTable, auditLogTable } from "@workspace/db";
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
  requireSmsConsent: z.boolean().optional(),
  allowImportedContactConsent: z.boolean().optional(),
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
        requireSmsConsent: true,
        allowImportedContactConsent: false,
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

    // Turning consent enforcement off is a compliance-significant decision:
    // the setting and its audit row (with the prior value) commit together.
    const settings = await db.transaction(async (tx) => {
      // Serialize concurrent updates: make sure the row exists (defaults match
      // the column defaults; a concurrent insert is a no-op), then lock it, so
      // the prior values below - and the audit rows derived from them - are
      // exactly what this update replaces.
      await tx
        .insert(orgSettingsTable)
        .values({ id: randomUUID(), orgId: authReq.orgId })
        .onConflictDoNothing({ target: orgSettingsTable.orgId });
      const [existing] = await tx
        .select({
          id: orgSettingsTable.id,
          requireSmsConsent: orgSettingsTable.requireSmsConsent,
          allowImportedContactConsent: orgSettingsTable.allowImportedContactConsent,
        })
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.orgId, authReq.orgId))
        .limit(1)
        .for("update");

      const updates: Record<string, unknown> = {};
      if (data.ahipSeasonOpenMonth !== undefined) updates.ahipSeasonOpenMonth = data.ahipSeasonOpenMonth;
      if (data.ahipSeasonOpenDay !== undefined) updates.ahipSeasonOpenDay = data.ahipSeasonOpenDay;
      if (data.ahipDeadlineMonth !== undefined) updates.ahipDeadlineMonth = data.ahipDeadlineMonth;
      if (data.ahipDeadlineDay !== undefined) updates.ahipDeadlineDay = data.ahipDeadlineDay;
      if (data.ahipReminderEnabled !== undefined) updates.ahipReminderEnabled = data.ahipReminderEnabled;
      if (data.ahipReminderIntervalWeeks !== undefined) updates.ahipReminderIntervalWeeks = data.ahipReminderIntervalWeeks;
      if (data.requireSmsConsent !== undefined) updates.requireSmsConsent = data.requireSmsConsent;
      if (data.allowImportedContactConsent !== undefined) updates.allowImportedContactConsent = data.allowImportedContactConsent;
      const [saved] = Object.keys(updates).length
        ? await tx.update(orgSettingsTable).set(updates).where(eq(orgSettingsTable.orgId, authReq.orgId)).returning()
        : await tx.select().from(orgSettingsTable).where(eq(orgSettingsTable.orgId, authReq.orgId)).limit(1);

      const before = existing!.requireSmsConsent;
      if (data.requireSmsConsent !== undefined && data.requireSmsConsent !== before) {
        await tx.insert(auditLogTable).values({
          id: randomUUID(),
          orgId: authReq.orgId,
          userId: authReq.userId,
          userRole: authReq.userRole ?? null,
          action: "update",
          resourceType: "org_settings.require_sms_consent",
          resourceId: authReq.orgId,
          changes: { requireSmsConsent: { from: before, to: data.requireSmsConsent } },
        });
      }
      // Voice consent for imported clients is compliance-significant too: the
      // change and its audit row (prior value) commit together. Not a
      // compliance finding - see lib/voice/consentBasis.ts.
      const importedBefore = existing!.allowImportedContactConsent;
      if (
        data.allowImportedContactConsent !== undefined &&
        data.allowImportedContactConsent !== importedBefore
      ) {
        await tx.insert(auditLogTable).values({
          id: randomUUID(),
          orgId: authReq.orgId,
          userId: authReq.userId,
          userRole: authReq.userRole ?? null,
          action: "update",
          resourceType: "org_settings.allow_imported_contact_consent",
          resourceId: authReq.orgId,
          changes: {
            allowImportedContactConsent: { from: importedBefore, to: data.allowImportedContactConsent },
          },
        });
      }
      return saved;
    });
    res.json(settings);
  },
);

export default router;
