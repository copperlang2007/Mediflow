/**
 * Callback SLA-queue re-attempt worker (scheduled cron).
 *
 * Drives the inbound-lead Callback SLA queue: each pass re-checks every `open`
 * `lead_callbacks` row against current routability and either resolves it (a
 * ready-to-sell + available agent now exists for its carrier × state), expires
 * it (the SLA deadline passed with still nobody), or leaves it open with the
 * attempt recorded. See lib/leadQueue/callbacks.ts for the semantics.
 *
 * This worker only delegates to the testable `sweepLeadCallbacks` (which is
 * fully injectable — db, clock, batch — so the behaviour is unit-tested
 * offline). Auto-DIALING a resolved callback is intentionally deferred (it
 * needs dial-ticket issuance + calling-hours/preclearance decisions); the sweep
 * tracks + resolves the queue only.
 */
import { logger } from "../lib/logger";
import { sweepLeadCallbacks } from "../lib/leadQueue/callbacks";

export async function leadCallbackSweepWorker(): Promise<void> {
  const summary = await sweepLeadCallbacks();
  logger.info({ ...summary }, "Lead callback sweep worker finished");
}
