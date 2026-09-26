/**
 * GoHighLevel contact feed worker.
 *
 *   - Scheduled every 15 min with `{}`: pulls every org in GHL_SYNC_ORG_IDS.
 *   - Enqueued from the admin endpoint with `{ orgId, full? }`: one org, and
 *     `full` restarts from the beginning (a backfill).
 *
 * A run that hits the page cap enqueues its own continuation so a large
 * backfill finishes promptly instead of waiting for the next tick. Errors are
 * recorded on the org's sync state and do NOT throw: the next tick is the
 * retry, which avoids stacking pg-boss retries on top of the schedule.
 */
import { eq } from "drizzle-orm";
import { db, ghlSyncStateTable } from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { ghlConfigFor, ghlConfigs, requestFullResync, runGhlSync } from "../lib/integrations/ghl/sync";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

export interface GhlSyncPayload {
  orgId?: string;
  full?: boolean;
}

/** At most one Sentry event per org per hour for a failure that repeats every tick. */
const CAPTURE_COOLDOWN_MS = 60 * 60 * 1000;
const lastCapturedAt = new Map<string, number>();

export async function ghlSyncWorker(payload: GhlSyncPayload = {}): Promise<void> {
  const configs = payload.orgId ? [ghlConfigFor(payload.orgId)].filter((c) => c !== null) : ghlConfigs();
  if (payload.orgId && configs.length === 0) {
    logger.warn({ orgId: payload.orgId }, "GHL sync: org is not configured");
    return;
  }
  // Orgs run concurrently: each has its own lease and state row, so one slow
  // or rate-limited agency never holds up the others.
  await Promise.all(configs.map(async (cfg) => {
    try {
      const result = await runGhlSync(cfg, { full: payload.full });
      lastCapturedAt.delete(cfg.orgId);
      if (result.status === "more_pending") {
        const id = await enqueue(JOB_NAMES.GHL_SYNC, { orgId: cfg.orgId });
        if (!id) {
          // Not lost — the next scheduled run resumes from the cursor — but a
          // big backfill would crawl one run per 15 minutes; make it visible.
          logger.error({ orgId: cfg.orgId }, "GHL sync: could not queue the continuation; the next scheduled run will resume");
          await db.update(ghlSyncStateTable)
            .set({ lastError: "Could not queue the next batch right away; the next scheduled sync (within 15 minutes) will continue." })
            .where(eq(ghlSyncStateTable.orgId, cfg.orgId));
        }
      } else if (result.status === "already_running" && payload.full) {
        // Don't drop the request, and don't queue another job per attempt:
        // flag it, and the active run starts the re-sync when it finishes.
        await requestFullResync(cfg);
      }
    } catch (err) {
      logger.error({ err, orgId: cfg.orgId }, "GHL sync: run failed");
      // The error is already on the admin status panel; a bad token would
      // otherwise send a Sentry event every 15 minutes.
      const last = lastCapturedAt.get(cfg.orgId) ?? 0;
      if (Date.now() - last > CAPTURE_COOLDOWN_MS) {
        captureWorkerError(err, { worker: "ghl-sync", orgId: cfg.orgId });
        lastCapturedAt.set(cfg.orgId, Date.now());
      }
    }
  }));
}
