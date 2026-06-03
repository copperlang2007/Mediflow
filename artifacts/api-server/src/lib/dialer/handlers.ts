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
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, dialTicketsTable, auditLogTable } from "@workspace/db";
import { logger } from "../logger";
import { isKnownEventType, type DialerEventEnvelope } from "./events";
import { raiseComplianceOversightTask } from "./oversight";
import { applyTerminalOutcome } from "./terminalOutcome";
import {
  parseTranscript,
  type TranscriptAiClient,
  type TranscriptParseResult,
} from "./transcriptParse";
import { markPresenceForTicket } from "../leadQueue/presence";

/**
 * Per-dispatch options. `aiClient` lets tests inject a mock AI client so the
 * `call.transcript.ready` parse runs fully offline; production passes nothing
 * and the BAA-gated default client is built inside `parseTranscript`.
 */
export interface DispatchOptions {
  aiClient?: TranscriptAiClient | null;
}

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

/**
 * Apply a lead-queue presence status derived from a call event, best-effort.
 * A presence write failure must never fail the webhook (the dialer would
 * needlessly retry), so errors are logged and swallowed.
 */
async function updatePresenceSafe(
  env: DialerEventEnvelope,
  status: "on_call" | "wrap",
): Promise<void> {
  if (!env.dialTicketId) return;
  try {
    await markPresenceForTicket({
      dialTicketId: env.dialTicketId,
      status,
      eventId: env.eventId,
    });
  } catch (err) {
    logger.warn(
      { err, dialTicketId: env.dialTicketId, status },
      "Lead-queue presence update from dialer event failed (ignored)",
    );
  }
}

async function handleTranscriptReady(
  env: DialerEventEnvelope,
  opts: DispatchOptions = {},
): Promise<HandlerResult> {
  const data = (env.data ?? {}) as {
    transcriptText?: unknown;
    redacted?: unknown;
  };
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

  // Phase 5 (§8): parse the transcript IN-PLATFORM via the MediFlow AI
  // provider for agent-assist. This is the only place PHI meets an LLM, and it
  // is the BAA-covered MediFlow provider — the dialer never sees the parsed
  // result. The parse is best-effort: a failure must not 5xx the webhook (the
  // dialer would needlessly retry, and the hash is already stored so the purge
  // can still be verified). We do NOT retain the raw transcript text beyond the
  // existing design (only its hash + the derived agent-assist result).
  const parsed = await parseTranscript(
    text,
    {
      dialTicketId: env.dialTicketId,
      orgId: env.orgId,
      redacted: typeof data.redacted === "boolean" ? data.redacted : undefined,
    },
    { aiClient: opts.aiClient },
  );

  if (parsed) {
    await db
      .update(dialTicketsTable)
      .set({ transcriptParsed: parsed, transcriptParsedAt: new Date() })
      .where(eq(dialTicketsTable.id, env.dialTicketId));
    await auditTranscriptParsed(env, parsed);
    return { ok: true, handled: true, note: "transcript_parsed" };
  }

  return { ok: true, handled: true, note: "transcript_ready_unparsed" };
}

/**
 * Audit the in-platform parse (§9). Records derived, non-PHI metadata about the
 * agent-assist result — never the raw transcript or the MBI.
 */
async function auditTranscriptParsed(
  env: DialerEventEnvelope,
  parsed: TranscriptParseResult,
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: env.orgId,
      userId: null,
      userRole: null,
      action: "create",
      resourceType: "dialer_transcript_parsed",
      resourceId: env.dialTicketId ?? env.eventId,
      changes: {
        eventId: env.eventId,
        dialTicketId: env.dialTicketId ?? null,
        dialerCallId: env.dialerCallId ?? null,
        riskFlagCount: parsed.riskFlags.length,
        actionItemCount: parsed.actionItems.length,
        // The parse ran in MediFlow via the BAA-covered AI provider; the
        // result is never returned to the dialer (Phase 5 exit criterion).
        parsedInPlatform: true,
      },
    });
  } catch (err) {
    logger.error(
      { err, dialTicketId: env.dialTicketId },
      "Transcript parse: failed to write audit log entry",
    );
  }
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
    { dialTicketId: env.dialTicketId, rule, detail },
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
 * `call.completed` / `call.failed` (§6) — the terminal lifecycle events.
 *
 * Routes through the shared `applyTerminalOutcome` so the webhook and the
 * Phase-6 reconciliation job (§5.4) apply the SAME terminal status + downstream
 * effects, guarded so they can never double-apply (§6.2). A duplicate or
 * out-of-order terminal webhook collapses to a no-op there. (The eventId ledger
 * in the route already dedupes exact duplicates; this guard additionally covers
 * two DIFFERENT events — e.g. a late webhook after the reconciler already
 * closed the ticket, or `call.failed` arriving after `call.completed`.)
 */
async function handleTerminalLifecycle(
  env: DialerEventEnvelope,
): Promise<HandlerResult> {
  await recordCallId(env);
  if (!env.dialTicketId) {
    // No ticket to anchor the outcome to; still acknowledged + audited.
    return { ok: true, handled: true, note: "terminal_no_ticket" };
  }
  const status = env.type === "call.completed" ? "COMPLETED" : "FAILED";
  const result = await applyTerminalOutcome({
    orgId: env.orgId,
    dialTicketId: env.dialTicketId,
    dialerCallId: env.dialerCallId ?? null,
    status,
    source: "webhook",
    eventId: env.eventId,
    detail: (env.data ?? {}) as Record<string, unknown>,
  });
  // Lead-queue presence: the call ended, so the agent moves to `wrap` (NOT
  // `available` — only their heartbeat returns them to the routable pool).
  // Best-effort: a presence failure must never 5xx the webhook.
  await updatePresenceSafe(env, "wrap");
  return {
    ok: true,
    handled: true,
    note: result.applied ? "terminal_applied" : "terminal_already_final",
  };
}

/**
 * Dispatch a known event to its handler. Unknown types are ignored
 * (forward-compat, §6.2) and reported as `handled: false`.
 */
export async function dispatchEvent(
  env: DialerEventEnvelope,
  opts: DispatchOptions = {},
): Promise<HandlerResult> {
  if (!isKnownEventType(env.type)) {
    return { ok: true, handled: false, note: "unknown_type_ignored" };
  }

  switch (env.type) {
    case "call.transcript.ready":
      return handleTranscriptReady(env, opts);
    case "call.transcript.purged":
      return handleTranscriptPurged(env);
    case "call.compliance.flagged":
      return handleComplianceFlagged(env);
    case "call.disposition.recorded":
      return handleDispositionRecorded(env);
    case "call.completed":
    case "call.failed":
      return handleTerminalLifecycle(env);
    case "call.in_progress":
      // The agent is now on a live call — remove them from the routable pool
      // (lead-queue presence). Best-effort; never 5xx the webhook.
      await recordCallId(env);
      await updatePresenceSafe(env, "on_call");
      return { ok: true, handled: true };
    case "call.initiated":
    case "call.ringing":
      // Pre-terminal: correlate the dialer call id where present; the
      // call-activity / pipeline wiring lands with the dialer service. The
      // terminal flip happens only on call.completed / call.failed.
      await recordCallId(env);
      return { ok: true, handled: true };
    default:
      return { ok: true, handled: false, note: "unknown_type_ignored" };
  }
}
