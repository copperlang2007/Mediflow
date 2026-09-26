/**
 * GoHighLevel contact feed — admin status + manual trigger.
 *
 *   GET  /integrations/ghl/status   configured?, cursor, last run, counts
 *   POST /integrations/ghl/sync     { full?: boolean } — queue a pull now;
 *                                   `full` re-reads everything (backfill)
 *
 * The token itself is never returned. See lib/integrations/ghl/sync.ts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, ghlSyncStateTable } from "@workspace/db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { ghlConfigFor, requestFullResync } from "../lib/integrations/ghl/sync";

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
    const alreadyRunning = !!state?.runningSince;
    const jobId = await enqueue(JOB_NAMES.GHL_SYNC, { orgId, full });
    if (!jobId && !full) {
      res.status(503).json({ error: "Sync service is temporarily unavailable. Please retry." });
      return;
    }
    res.status(202).json({ queued: true, full, alreadyRunning });
  },
);

export default router;
