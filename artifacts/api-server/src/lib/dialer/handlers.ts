/**
 * Per-type dispatch for inbound dialer events (spec §6).
 *
 * Most handlers are intentionally thin in Phase 2 — the downstream wiring
 * (call-activity rows, pipeline updates, retry scheduling, AI transcript
 * parsing) lands in Phases 4/5. The two handlers that carry real Phase-2
 * behaviour are:
 *
 *   - `call.transcript.ready`   — record the transcript hash + ready time on
 *     the dial ticket so the subsequent purge can be verified (§6.1).
 *   - `call.transcript.purged`  — verify the supplied `transcriptHash` matches
 *     what we recorded and stamp `transcriptPurgeConfirmedAt` (§6.1).
 *   - `call.compliance.flagged` — handled distinctly: surfaced for the
 *     compliance path (oversight wiring is Phase 4).
 *
 * Unknown event types never reach here — the dispatcher ignores them (§6.2).
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, dialTicketsTable } from "@workspace/db";
import { logger } from "../logger";
import { isKnownEventType, type DialerEventEnvelope } from "./events";
import { raiseComplianceOversightTask } from "./oversight";

/** SHA-256 hex of the transcript text MediFlow received (§6.1). */
export function transcriptHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export interface HandlerResult {
  /** False only for a genuine processing failure that should 5xx. */
  ok: boolean;
  /** Set when a known type was matched (vs. ignored as unknown). */
  handled: boolean;
  note?: string;
}

async function recordCallId(env: DialerEventEnvelope): Promise<void> {
  if (!env.dialTicketId || !env.dialerCallId) return;
  await db
    .update(dialTicketsTable)
    .set({ dialerCallId: env.dialerCallId })
    .where(eq(dialTicketsTable.id, env.dialTicketId));
}

async function handleTranscriptReady(
  env: DialerEventEnvelope,
): Promise<HandlerResult> {
  const data = (env.data ?? {}) as { transcriptText?: unknown };
  const text =
    typeof data.transcriptText === "string" ? data.transcriptText : null;
  if (!env.dialTicketId || text === null) {
    // Nothing to anchor the later purge to; still acknowledged + audited.
    return { ok: true, handled: true, note: "transcript_ready_no_anchor" };
  }
  await db
    .update(dialTicketsTable)
    .set({
      transcriptHash: transcriptHash(text),
      transcriptReadyAt: new Date(),
      dialerCallId: env.dialerCallId ?? undefined,
    })
    .where(eq(dialTicketsTable.id, env.dialTicketId));
  // TODO(Phase 5): store transcript (encrypted) + kick Azure-OpenAI parsing.
  return { ok: true, handled: true };
}

async function handleTranscriptPurged(
  env: DialerEventEnvelope,
): Promise<HandlerResult> {
  const data = (env.data ?? {}) as {
    transcriptHash?: unknown;
    purgedAt?: unknown;
  };
  const claimedHash =
    typeof data.transcriptHash === "string" ? data.transcriptHash : null;

  if (!env.dialTicketId) {
    return { ok: true, handled: true, note: "purge_no_ticket" };
  }

  const [ticket] = await db
    .select({ transcriptHash: dialTicketsTable.transcriptHash })
    .from(dialTicketsTable)
    .where(eq(dialTicketsTable.id, env.dialTicketId))
    .limit(1);

  // Verify the hash matches what we stored on transcript.ready (§6.1).
  if (
    ticket?.transcriptHash &&
    claimedHash &&
    ticket.transcriptHash !== claimedHash
  ) {
    logger.error(
      { dialTicketId: env.dialTicketId },
      "Dialer transcript purge: hash mismatch — purge NOT confirmed",
    );
    // A mismatch is a compliance signal, not a transport failure: ack 2xx
    // (so the dialer stops retrying) but do not stamp confirmation.
    // TODO(Phase 4): raise a compliance alert to compliance_manager.
    return { ok: true, handled: true, note: "purge_hash_mismatch" };
  }

  await db
    .update(dialTicketsTable)
    .set({ transcriptPurgeConfirmedAt: new Date() })
    .where(eq(dialTicketsTable.id, env.dialTicketId));
  return { ok: true, handled: true };
}

async function handleComplianceFlagged(
  env: DialerEventEnvelope,
): Promise<HandlerResult> {
  const data = (env.data ?? {}) as { rule?: unknown; detail?: unknown };
  const rule = typeof data.rule === "string" ? data.rule : null;
  const detail = typeof data.detail === "string" ? data.detail : null;
  logger.warn(
    { dialTicketId: env.dialTicketId, rule },
    "Dialer compliance flag received",
  );
  await recordCallId(env);
  // Raise an oversight task for a compliance manager / agency admin (§6, §9).
  await raiseComplianceOversightTask({
    orgId: env.orgId,
    eventId: env.eventId,
    dialTicketId: env.dialTicketId ?? null,
    dialerCallId: env.dialerCallId ?? null,
    trigger: "flag",
    reason: rule,
    detail,
  });
  return { ok: true, handled: true };
}

/**
 * `call.disposition.recorded` (§6). A COMPLIANCE-category disposition raises
 * an oversight task; any other category is correlated and acknowledged.
 */
async function handleDispositionRecorded(
  env: DialerEventEnvelope,
): Promise<HandlerResult> {
  await recordCallId(env);
  const data = (env.data ?? {}) as {
    code?: unknown;
    category?: unknown;
    notes?: unknown;
  };
  const category =
    typeof data.category === "string" ? data.category.toUpperCase() : null;
  if (category !== "COMPLIANCE") {
    return { ok: true, handled: true };
  }
  const code = typeof data.code === "string" ? data.code : null;
  const notes = typeof data.notes === "string" ? data.notes : null;
  await raiseComplianceOversightTask({
    orgId: env.orgId,
    eventId: env.eventId,
    dialTicketId: env.dialTicketId ?? null,
    dialerCallId: env.dialerCallId ?? null,
    trigger: "disposition",
    reason: code,
    detail: notes,
  });
  return { ok: true, handled: true, note: "compliance_disposition" };
}

/**
 * Dispatch a known event to its handler. Unknown types are ignored
 * (forward-compat, §6.2) and reported as `handled: false`.
 */
export async function dispatchEvent(
  env: DialerEventEnvelope,
): Promise<HandlerResult> {
  if (!isKnownEventType(env.type)) {
    return { ok: true, handled: false, note: "unknown_type_ignored" };
  }

  switch (env.type) {
    case "call.transcript.ready":
      return handleTranscriptReady(env);
    case "call.transcript.purged":
      return handleTranscriptPurged(env);
    case "call.compliance.flagged":
      return handleComplianceFlagged(env);
    case "call.disposition.recorded":
      return handleDispositionRecorded(env);
    case "call.initiated":
    case "call.ringing":
    case "call.in_progress":
    case "call.completed":
    case "call.failed":
      // Thin: correlate the dialer call id where present; the call-activity /
      // pipeline wiring lands in later phases.
      await recordCallId(env);
      return { ok: true, handled: true };
    default:
      return { ok: true, handled: false, note: "unknown_type_ignored" };
  }
}
