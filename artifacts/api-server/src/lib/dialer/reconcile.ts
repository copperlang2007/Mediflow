/**
 * Dial-ticket reconciliation (spec §5.4, §10 Phase 6).
 *
 * A dial ticket whose terminal lifecycle webhook (`call.completed` /
 * `call.failed`) was dropped would hang forever in a pre-terminal state
 * (§6.2 requires consumers to tolerate missed delivery). This module finds
 * those stuck tickets, fetches the AUTHORITATIVE call state from the dialer's
 * `GET /dialer/v1/calls/{id}` (§5.4) via the service-JWT read client, and
 * applies the missed terminal outcome through the SAME idempotent
 * `applyTerminalOutcome` the webhook uses — so a late webhook and the
 * reconciler can never double-apply, and a reconciled call raises the same
 * downstream effects + audit a webhook-delivered one would.
 *
 * Everything is injectable (db, read client, clock, staleness window) so the
 * worker's behaviour is fully testable against a mock dialer offline.
 */
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db as defaultDb, dialTicketsTable } from "@workspace/db";
import { logger } from "../logger";
import { captureWorkerError } from "../sentry";
import {
  type DialerReadClient,
  mapDialerStatusToOutcome,
} from "./readClient";
import { applyTerminalOutcome, TERMINAL_STATUSES } from "./terminalOutcome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReconcileDb = typeof defaultDb | any;

/**
 * Pre-terminal statuses a ticket can be stuck in: it was issued / dialing but
 * never reached a terminal state. `QUEUED` is included so a ticket that was
 * issued but whose call never started is still chased (the dialer returns 404
 * for a call it never knew → we leave it for a human / TTL).
 */
export const PRE_TERMINAL_STATUSES = [
  "QUEUED",
  "ISSUED",
  "CALLING",
] as const;

/** Default staleness window before a pre-terminal ticket is reconciled. */
export const DEFAULT_STALENESS_MINUTES = 30;

export interface ReconcileOptions {
  db?: ReconcileDb;
  readClient: DialerReadClient;
  /** How old (since last update) a ticket must be before we chase it. */
  stalenessMinutes?: number;
  /** Max tickets to reconcile in one sweep (back-pressure). */
  batchSize?: number;
  now?: () => Date;
}

export interface ReconcileSummary {
  scanned: number;
  reconciled: number;
  stillPending: number;
  notFound: number;
  errors: number;
}

interface StuckTicket {
  id: string;
  orgId: string;
  dialerCallId: string | null;
}

/**
 * Reconcile stuck dial tickets. Returns a summary for logging / metrics.
 *
 * Idempotent by construction: the terminal flip goes through
 * `applyTerminalOutcome`'s conditional UPDATE, so re-running the sweep (or a
 * webhook arriving between fetch and apply) never double-applies.
 */
export async function reconcileStuckTickets(
  opts: ReconcileOptions,
): Promise<ReconcileSummary> {
  const db: ReconcileDb = opts.db ?? defaultDb;
  const now = (opts.now ?? (() => new Date()))();
  const stalenessMinutes = opts.stalenessMinutes ?? DEFAULT_STALENESS_MINUTES;
  const batchSize = opts.batchSize ?? 100;
  const cutoff = new Date(now.getTime() - stalenessMinutes * 60 * 1000);

  const summary: ReconcileSummary = {
    scanned: 0,
    reconciled: 0,
    stillPending: 0,
    notFound: 0,
    errors: 0,
  };

  // A ticket is reconcilable only if it has a dialerCallId (the call actually
  // started) — without it there is no call to GET (§5.4). Such tickets are
  // left for the TTL / revoke path. We also require pre-terminal status and
  // a stale `updated_at` so a call that is legitimately still ringing is not
  // chased prematurely.
  const stuck: StuckTicket[] = await db
    .select({
      id: dialTicketsTable.id,
      orgId: dialTicketsTable.orgId,
      dialerCallId: dialTicketsTable.dialerCallId,
    })
    .from(dialTicketsTable)
    .where(
      and(
        inArray(dialTicketsTable.status, [...PRE_TERMINAL_STATUSES]),
        isNotNull(dialTicketsTable.dialerCallId),
        lt(dialTicketsTable.updatedAt, cutoff),
      ),
    )
    .limit(batchSize);

  summary.scanned = stuck.length;
  if (stuck.length === 0) return summary;

  logger.info(
    { count: stuck.length, stalenessMinutes },
    "Dialer reconciliation: scanning stuck tickets",
  );

  for (const ticket of stuck) {
    try {
      const fetched = await opts.readClient.fetchCallState(
        ticket.dialerCallId as string,
      );

      if (!fetched.ok) {
        if (fetched.reason === "not_found") {
          // The dialer never knew this call — nothing to reconcile from here.
          summary.notFound++;
        } else {
          summary.errors++;
        }
        continue;
      }

      const outcome = mapDialerStatusToOutcome(fetched.state.status);
      if (!outcome.terminal) {
        // Authoritatively still in flight — leave it for the next sweep.
        summary.stillPending++;
        continue;
      }

      const detail =
        outcome.status === "COMPLETED"
          ? {
              duration: fetched.state.duration,
              endedReason: fetched.state.endedReason,
            }
          : { reason: fetched.state.reason ?? fetched.state.status };

      const applied = await applyTerminalOutcome(
        {
          orgId: ticket.orgId,
          dialTicketId: ticket.id,
          dialerCallId: ticket.dialerCallId,
          status: outcome.status,
          source: "reconciliation",
          detail,
          now: () => now,
        },
        db,
      );

      if (applied.applied) {
        summary.reconciled++;
        logger.info(
          {
            dialTicketId: ticket.id,
            orgId: ticket.orgId,
            status: outcome.status,
          },
          "Dialer reconciliation: recovered missed terminal outcome",
        );
      } else {
        // A webhook beat us to it between the scan and the apply — fine.
        summary.stillPending++;
      }
    } catch (err) {
      summary.errors++;
      logger.error(
        { err, dialTicketId: ticket.id },
        "Dialer reconciliation: failed for ticket — skipping",
      );
      captureWorkerError(err, {
        worker: "dialerReconcile",
        dialTicketId: ticket.id,
      });
    }
  }

  logger.info({ ...summary }, "Dialer reconciliation: sweep complete");
  return summary;
}

/** Re-exported so callers can reason about which statuses are terminal. */
export { TERMINAL_STATUSES };
