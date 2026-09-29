/**
 * GoHighLevel contact feed — admin status + manual trigger.
 *
 *   GET  /integrations/ghl/status   configured?, cursor, last run, counts
 *   POST /integrations/ghl/sync     { full?: boolean } — queue a pull now;
 *                                   `full` re-reads everything (backfill)
 *   GET  /integrations/ghl/custom-fields  the sub-account's contact custom
 *                                   field definitions (names and types only,
 *                                   never a contact's value) — used to map
 *                                   fields such as Sunfire plan data
 *
 * The token itself is never returned. See lib/integrations/ghl/sync.ts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, ghlSyncStateTable } from "@workspace/db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { LEASE_MINUTES, ghlConfigFor, requestFullResync } from "../lib/integrations/ghl/sync";
import { GhlApiError, listContactCustomFields } from "../lib/integrations/ghl/client";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get(
  "/integrations/ghl/status",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const cfg = ghlConfigFor(orgId);
    const [state] = await db.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, orgId)).limit(1);
    res.json({
      configured: !!cfg,
      locationId: cfg?.locationId ?? null,
      running: !!state?.runningSince,
      cursorUpdatedAt: state?.cursorUpdatedAt ?? null,
      backfillCompletedAt: state?.backfillCompletedAt ?? null,
      lastRunAt: state?.lastRunAt ?? null,
      lastStatus: state?.lastStatus ?? null,
      lastError: state?.lastError ?? null,
      lastRun: state
        ? { created: state.lastRunCreated, updated: state.lastRunUpdated, skipped: state.lastRunSkipped, failed: state.lastRunFailed }
        : null,
    });
  },
);

router.post(
  "/integrations/ghl/sync",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const cfg = ghlConfigFor(orgId);
    if (!cfg) {
      res.status(400).json({
        error: "GoHighLevel isn't connected for this agency yet. An administrator needs to add the Private Integration token and location id.",
      });
      return;
    }
    const full = req.body?.full === true;
    // Recorded first, so the request survives even if the job can't be queued
    // right now (the next scheduled run honours it).
    if (full) await requestFullResync(cfg);
    const [state] = await db.select({ runningSince: ghlSyncStateTable.runningSince })
      .from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, orgId)).limit(1);
    // A lease older than LEASE_MINUTES belongs to a crashed run and will be reclaimed.
    const alreadyRunning = !!state?.runningSince && state.runningSince.getTime() > Date.now() - LEASE_MINUTES * 60_000;
    const jobId = await enqueue(JOB_NAMES.GHL_SYNC, { orgId, full });
    if (!jobId && !full) {
      res.status(503).json({ error: "Sync service is temporarily unavailable. Please retry." });
      return;
    }
    res.status(202).json({ queued: true, full, alreadyRunning });
  },
);

router.get(
  "/integrations/ghl/custom-fields",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const cfg = ghlConfigFor(orgId);
    if (!cfg) {
      res.status(400).json({
        error: "GoHighLevel isn't connected for this agency yet. An administrator needs to add the Private Integration token and location id.",
      });
      return;
    }
    try {
      const fields = await listContactCustomFields({ token: cfg.token, locationId: cfg.locationId });
      res.json({ locationId: cfg.locationId, fields });
    } catch (err) {
      // GhlApiError messages are written for admins and never carry the token
      // or the upstream body; anything else stays in the log.
      if (err instanceof GhlApiError) {
        res.status(502).json({ error: err.message });
        return;
      }
      logger.error({ err, orgId }, "GHL custom fields: request failed");
      res.status(502).json({ error: "Couldn't reach GoHighLevel. Please retry." });
    }
  },
);

export default router;
