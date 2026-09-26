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
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { ghlConfigFor, ghlConfigs, runGhlSync } from "../lib/integrations/ghl/sync";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

export interface GhlSyncPayload {
  orgId?: string;
  full?: boolean;
}

export async function ghlSyncWorker(payload: GhlSyncPayload = {}): Promise<void> {
  const configs = payload.orgId ? [ghlConfigFor(payload.orgId)].filter((c) => c !== null) : ghlConfigs();
  if (payload.orgId && configs.length === 0) {
    logger.warn({ orgId: payload.orgId }, "GHL sync: org is not configured");
    return;
  }
  for (const cfg of configs) {
    try {
      const result = await runGhlSync(cfg, { full: payload.full });
      if (result.status === "more_pending") {
        await enqueue(JOB_NAMES.GHL_SYNC, { orgId: cfg.orgId });
      }
    } catch (err) {
      logger.error({ err, orgId: cfg.orgId }, "GHL sync: run failed");
      captureWorkerError(err, { worker: "ghl-sync", orgId: cfg.orgId });
    }
  }
}
