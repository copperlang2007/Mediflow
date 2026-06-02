/**
 * Apply a terminal call outcome to a dial ticket — exactly once (Phase 6,
 * §5.4, §6.2).
 *
 * A terminal outcome (`COMPLETED` / `FAILED`) can arrive via TWO independent
 * paths that must never double-apply:
 *
 *   1. The inbound webhook — `call.completed` / `call.failed` (§6).
 *   2. The reconciliation job — recovering a MISSED webhook from
 *      `GET /dialer/v1/calls/{id}` (§5.4).
 *
 * Both funnel through `applyTerminalOutcome`. Idempotency is enforced by a
 * conditional UPDATE: the terminal status is written only while the ticket is
 * still pre-terminal (`status NOT IN (terminal set)`). Whichever path arrives
 * first wins; the second is a no-op (`applied: false`). This is the
 * terminal-state guard the spec requires so a late webhook and the reconciler
 * (or a duplicate/out-of-order webhook) collapse to a single application.
 *
 * The function is the single source of truth for "what happens when a call
 * reaches a terminal state": the status flip plus (in later phases) the
 * downstream effects the webhook would raise — call-activity finalization,
 * pipeline update, retry scheduling on failure. Those downstream effects live
 * here so the reconciler raises the SAME effects as the webhook (exit
 * criterion: reconciliation "raises the same downstream effects the webhook
 * would have").
 */
import { and, eq, inArray, not } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db as defaultDb,
  dialTicketsTable,
  auditLogTable,
} from "@workspace/db";
import { logger } from "../logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OutcomeDb = typeof defaultDb | any;

/** Terminal ticket statuses — once a ticket holds one, the outcome is fixed. */
export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "REVOKED"] as const;
export type TerminalStatus = "COMPLETED" | "FAILED";

export interface ApplyTerminalOutcomeInput {
  orgId: string;
  dialTicketId: string;
  dialerCallId?: string | null;
  /** The terminal status to apply. */
  status: TerminalStatus;
  /** Where the outcome came from — drives auditing + the `reconciled_at` stamp. */
  source: "webhook" | "reconciliation";
  /** Correlating event id (webhook) — for the audit trail. */
  eventId?: string | null;
  /** Type-specific detail (duration/endedReason for completed, reason for failed). */
  detail?: Record<string, unknown>;
  /** Injected clock so tests are deterministic. */
  now?: () => Date;
}

export interface ApplyTerminalOutcomeResult {
  /** True when THIS call flipped the ticket; false when already terminal. */
  applied: boolean;
  /** The status the ticket now holds (the existing one if not applied). */
  status: string | null;
}

/**
 * Apply (idempotently) a terminal outcome. Returns `applied: false` when the
 * ticket was already terminal — the guard that stops the webhook and the
 * reconciler from double-processing the same call.
 */
export async function applyTerminalOutcome(
  input: ApplyTerminalOutcomeInput,
  db: OutcomeDb = defaultDb,
): Promise<ApplyTerminalOutcomeResult> {
  const now = (input.now ?? (() => new Date()))();

  // Conditional flip: only while the ticket is still pre-terminal. The
  // `.returning()` rows tell us whether THIS call won the race. A ticket that
  // is already COMPLETED/FAILED/REVOKED matches nothing → no row → no-op.
  const updated = await db
    .update(dialTicketsTable)
    .set({
      status: input.status,
      dialerCallId: input.dialerCallId ?? undefined,
      ...(input.source === "reconciliation" ? { reconciledAt: now } : {}),
    })
    .where(
      and(
        eq(dialTicketsTable.id, input.dialTicketId),
        not(inArray(dialTicketsTable.status, [...TERMINAL_STATUSES])),
      ),
    )
    .returning({ id: dialTicketsTable.id, status: dialTicketsTable.status });

  if (updated.length === 0) {
    // Already terminal — the other path got here first. No-op (idempotent).
    const [existing] = await db
      .select({ status: dialTicketsTable.status })
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, input.dialTicketId))
      .limit(1);
    return { applied: false, status: existing?.status ?? null };
  }

  // --- Downstream effects the webhook would raise (§6) -------------------
  // Both paths run these so a reconciled call is indistinguishable from a
  // webhook-delivered one. Phases 2–5 kept call-activity / pipeline / retry
  // wiring thin (it lands with the dialer service in the companion repo); the
  // audit row below is the durable, tenant-scoped effect that exists today and
  // is asserted by the missed-webhook recovery test. As that wiring lands, it
  // is added here (one place) so the two paths can never diverge.
  await auditTerminalOutcome(input, now, db);

  return { applied: true, status: input.status };
}

async function auditTerminalOutcome(
  input: ApplyTerminalOutcomeInput,
  now: Date,
  db: OutcomeDb,
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: input.orgId,
      userId: null,
      userRole: null,
      action: "update",
      resourceType: "dial_ticket_outcome",
      resourceId: input.dialTicketId,
      changes: {
        status: input.status,
        source: input.source,
        eventId: input.eventId ?? null,
        dialerCallId: input.dialerCallId ?? null,
        // Surfaces the missed-webhook recovery in the immutable trail.
        recoveredByReconciliation: input.source === "reconciliation",
        recoveredAt: input.source === "reconciliation" ? now.toISOString() : null,
        detail: input.detail ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, dialTicketId: input.dialTicketId, source: input.source },
      "Dial ticket terminal outcome: failed to write audit log entry",
    );
  }
}
