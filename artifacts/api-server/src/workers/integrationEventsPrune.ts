/**
 * Daily prune of the integration_events idempotency ledger.
 *
 * The ledger only needs to outlive a sender's redelivery window (EnrollHere
 * retries within minutes to hours). Rows older than RETENTION_DAYS are
 * deleted so the table and its indexes don't grow without bound. The call
 * log itself lives in `activities` and is untouched.
 */
import { lt } from "drizzle-orm";
import { db, integrationEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const RETENTION_DAYS = 90;

export async function integrationEventsPruneWorker(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const deleted = await db.delete(integrationEventsTable)
    .where(lt(integrationEventsTable.receivedAt, cutoff))
    .returning({ id: integrationEventsTable.id });
  if (deleted.length) logger.info({ deleted: deleted.length }, "integration-events-prune: removed old ledger rows");
  return deleted.length;
}
