/**
 * AEP annual-review task generation worker (scheduled cron).
 *
 * Runs once a year (Sept 1 UTC — comfortably before the Oct 1 cutoff) and
 * creates one "set the annual review appointment" to-do per current MA member
 * across every org, assigned to the member's agent, due Sept 30. See
 * lib/aepRenewal/generate.ts for the member signal + idempotency semantics.
 *
 * The worker only delegates to the fully-injectable `generateAepRenewalTasks`
 * (db / now / dueAt are injectable), so the behaviour is unit-tested offline
 * against the pglite harness with a fixed clock. The pass is idempotent, so a
 * pg-boss redelivery or a manual admin re-trigger is a safe no-op.
 */
import { logger } from "../lib/logger";
import { generateAepRenewalTasks } from "../lib/aepRenewal/generate";

export async function aepRenewalReviewWorker(): Promise<void> {
  const summary = await generateAepRenewalTasks();
  logger.info({ ...summary }, "AEP renewal review worker finished");
}
