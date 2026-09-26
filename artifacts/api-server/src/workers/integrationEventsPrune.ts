/**
 * Daily prune of the integration_events idempotency ledger.
 *
 * The ledger only needs to outlive a sender's redelivery window (EnrollHere
 * retries within minutes to hours). Rows older than RETENTION_DAYS are
 * deleted so the table and its indexes don't grow without bound. The call
 * log itself lives in `activities` and is untouched.
 */
import { inArray, lt } from "drizzle-orm";
import { db, integrationEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const RETENTION_DAYS = 90;
const BATCH = 5000;

export async function integrationEventsPruneWorker(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  // Small batches: a backlog (first run, long outage) never becomes one huge
  // transaction holding locks on the ledger.
  let total = 0;
  for (;;) {
    const ids = (await db.select({ id: integrationEventsTable.id }).from(integrationEventsTable)
      .where(lt(integrationEventsTable.receivedAt, cutoff)).limit(BATCH)).map((r) => r.id);
    if (ids.length === 0) break;
    await db.delete(integrationEventsTable).where(inArray(integrationEventsTable.id, ids));
    total += ids.length;
    if (ids.length < BATCH) break;
  }
  if (total) logger.info({ deleted: total }, "integration-events-prune: removed old ledger rows");
  return total;
}
