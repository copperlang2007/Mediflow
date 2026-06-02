/**
 * Dial-ticket reconciliation worker (scheduled cron, spec §5.4, §10 Phase 6).
 *
 * Recovers MISSED terminal webhooks: a dial ticket left in a pre-terminal
 * state past the staleness window is chased against the dialer's
 * `GET /dialer/v1/calls/{id}` and its authoritative terminal outcome applied
 * once (idempotent vs. a late webhook — see `lib/dialer/reconcile.ts`).
 *
 * This worker only WIRES the production read client (service-JWT signing key +
 * base URL from the environment) and delegates to the testable
 * `reconcileStuckTickets`. When the dialer integration is not configured
 * (signing key / base URL absent — e.g. before the companion dialer service is
 * deployed), it logs and no-ops rather than throwing, so the cron stays green.
 */
import { logger } from "../lib/logger";
import {
  DialerReadClient,
  fetchReadHttpClient,
} from "../lib/dialer/readClient";
import { resolveSigningKeyFromEnv } from "../lib/dialer/serviceJwt";
import {
  reconcileStuckTickets,
  DEFAULT_STALENESS_MINUTES,
} from "../lib/dialer/reconcile";

/**
 * Resolve the staleness window from the environment, clamped to a sane range.
 * `DIALER_RECONCILE_STALENESS_MINUTES` (default 30). A ticket must be stale
 * by at least this long before it is chased so a legitimately in-flight call
 * is never closed prematurely.
 */
function resolveStalenessMinutes(): number {
  const raw = Number(process.env.DIALER_RECONCILE_STALENESS_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STALENESS_MINUTES;
  // Floor at 5 min (never chase a brand-new call), cap at 24h.
  return Math.min(Math.max(raw, 5), 24 * 60);
}

export async function dialerReconcileWorker(): Promise<void> {
  const baseUrl = process.env.DIALER_BASE_URL?.trim();
  const signing = resolveSigningKeyFromEnv();

  if (!baseUrl || !signing) {
    logger.info(
      { hasBaseUrl: Boolean(baseUrl), hasSigningKey: Boolean(signing) },
      "Dialer reconciliation: integration not configured — skipping sweep",
    );
    return;
  }

  const readClient = new DialerReadClient({
    dialerBaseUrl: baseUrl,
    signingPrivateKey: signing.privateKey,
    signingKeyId: signing.keyId,
    httpClient: fetchReadHttpClient,
  });

  const summary = await reconcileStuckTickets({
    readClient,
    stalenessMinutes: resolveStalenessMinutes(),
  });

  logger.info({ ...summary }, "Dialer reconciliation worker finished");
}
