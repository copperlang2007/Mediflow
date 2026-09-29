/**
 * Call session lifecycle for native browser calling.
 *
 *   placeCall()          — preclearance + backstops, then a `call_sessions` row
 *                          (`initiated`, or `blocked` as an audit trail).
 *   claimSessionForDial()— the Voice webhook's atomic, single-use claim.
 *   applyStatusUpdate()  — status callbacks: ordered, idempotent, and writes the
 *                          `call_log` activity exactly once on the terminal event.
 *
 * Mediflow is the source of truth: the number to dial is derived HERE from the
 * contact record and stored; nothing the browser sends can change it. No MBI is
 * read, stored or logged, and phone numbers never go to logs or the audit log.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  db,
  activitiesTable,
  agentsTable,
  callSessionsTable,
  contactsTable,
  type CallSession,
  type CallSessionStatus,
} from "@workspace/db";
import {
  runPreclearance,
  type PreclearanceFailure,
  type ProductLine,
} from "../dialer/preclearance";
import { isNumberOptedOutAnyOrg } from "../compliance/optOut";
import { toDialableE164 } from "./phone";
import { voiceCallerId, missingVoiceEnv, type VoiceEnvName } from "./voiceToken";
import { resolveDialLimits, type DialLimits } from "./dialLimits";

/** A call session is claimable by the Voice webhook for this long after creation. */
export const CALL_SESSION_TTL_MS = 2 * 60 * 1000;

/**
 * A ringing / in-progress session with no terminal callback after this long is
 * treated as dead (no phone call lasts this long; Twilio's own hard cap is
 * 4 hours) and marked `failed`.
 */
export const MAX_LIVE_CALL_MS = 4 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<any, any, any>;

/**
 * Lazy expiry: mark this org's non-terminal (ringing / in_progress) sessions
 * older than MAX_LIVE_CALL_MS as `failed` with `ended_at` set. Run when listing
 * calls and when checking attempt limits, so a lost callback cannot leave a
 * session "live" forever. No call_log is written for an expired session (we
 * never learned how the call ended). Returns how many rows were expired.
 */
export async function expireStaleLiveSessions(
  handle: AnyPgDb,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - MAX_LIVE_CALL_MS);
  const stale = and(
    eq(callSessionsTable.orgId, orgId),
    inArray(callSessionsTable.status, ["ringing", "in_progress"]),
    lt(sql`coalesce(${callSessionsTable.startedAt}, ${callSessionsTable.createdAt})`, cutoff),
  );
  // Cheap read probe first: listing must not open a write on every request
  // when (as is almost always the case) nothing is stale.
  const [probe] = await handle
    .select({ id: callSessionsTable.id })
    .from(callSessionsTable)
    .where(stale)
    .limit(1);
  if (!probe) return 0;
  const rows = await handle
    .update(callSessionsTable)
    .set({ status: "failed", endedAt: now })
    .where(stale)
    .returning({ id: callSessionsTable.id });
  return rows.length;
}

export type BlockCode =
  | PreclearanceFailure["code"]
  | "INVALID_NUMBER"
  | "AGENT_NOT_ELIGIBLE"
  | "MAX_ATTEMPTS_EXCEEDED"
  | "REDIAL_COOLDOWN"
  | "TOO_MANY_ABANDONED_ATTEMPTS";

export interface BlockReason {
  code: BlockCode;
  detail: string;
}

export type PlaceCallResult =
  | { kind: "not_found" }
  | { kind: "needs_setup"; missing: VoiceEnvName[] }
  | { kind: "blocked"; callSessionId: string; reasons: BlockReason[] }
  // Over the abandoned-attempt ceiling: refused WITHOUT storing another row.
  | { kind: "throttled"; reasons: BlockReason[] }
  | { kind: "ok"; callSessionId: string; to: string };

const AGENT_CODES = new Set<PreclearanceFailure["code"]>([
  "AGENT_NOT_LICENSED",
  "AGENT_LICENSE_EXPIRED",
  "AGENT_NO_AHIP",
  "AGENT_NOT_CERTIFIED",
]);

export interface PlaceCallInput {
  orgId: string;
  userId: string;
  userRole: string;
  contactId: string;
  productLine?: ProductLine;
  now?: Date;
  limits?: DialLimits;
}

const PRODUCT_LINES: readonly ProductLine[] = ["MA", "PDP", "MAPD", "supp", "other"];
const STRICT_LINES: readonly ProductLine[] = ["MA", "PDP", "MAPD"];

/** Contact's stored plan type wins; a request may only supply a strict line when none is stored. */
export function resolveProductLine(
  stored: string | null | undefined,
  requested: ProductLine | undefined,
): ProductLine {
  if (stored) {
    // An unrecognised stored value fails closed to the strictest line.
    return PRODUCT_LINES.includes(stored as ProductLine) ? (stored as ProductLine) : "MAPD";
  }
  return requested && STRICT_LINES.includes(requested) ? requested : "MAPD";
}

async function callerAgentProfile(orgId: string, userId: string) {
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, orgId), eq(agentsTable.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
  const now = input.now ?? new Date();
  const limits = input.limits ?? resolveDialLimits();

  const [contact] = await db
    .select({
      id: contactsTable.id,
      phone: contactsTable.phone,
      stateCode: contactsTable.stateCode,
      zipCode: contactsTable.zipCode,
      currentPlanType: contactsTable.currentPlanType,
      assignedAgentId: contactsTable.assignedAgentId,
      status: contactsTable.status,
      tcpaConsentAt: contactsTable.tcpaConsentAt,
      tcpaConsentSource: contactsTable.tcpaConsentSource,
    })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, input.contactId),
        eq(contactsTable.orgId, input.orgId),
        sql`${contactsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!contact) return { kind: "not_found" };

  const mine = await callerAgentProfile(input.orgId, input.userId);

  // The plain `agent` role may call only contacts assigned to their own agent
  // profile. Anything else is indistinguishable from a missing contact.
  if (input.userRole === "agent") {
    if (!mine || contact.assignedAgentId !== mine.id) return { kind: "not_found" };
  }

  const missing = missingVoiceEnv();
  const callerId = voiceCallerId();
  if (missing.length > 0 || !callerId) {
    return { kind: "needs_setup", missing: missing.length > 0 ? missing : ["TWILIO_VOICE_CALLER_ID"] };
  }

  // Whose licensing is checked: the caller's own agent profile, else the
  // contact's assigned agent. With neither, fail closed.
  let agentId: string | null = mine?.id ?? null;
  if (!agentId && contact.assignedAgentId) {
    const [assigned] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, contact.assignedAgentId), eq(agentsTable.orgId, input.orgId)))
      .limit(1);
    agentId = assigned?.id ?? null;
  }

  // The product line decides how strict the agent checks are (AHIP + carrier
  // certification for MA/PDP/MAPD), so the CALLER never gets to lower it. It is
  // the contact's stored plan type when there is one; a request value is only
  // considered when the contact has none, and only if it is a carrier-appointed
  // line (never `supp` / `other`, which skip AHIP and certification).
  const productLine: ProductLine = resolveProductLine(contact.currentPlanType, input.productLine);
  const reasons: BlockReason[] = [];

  // 1) The number must be a valid, dialable NANP number.
  const toNumber = toDialableE164(contact.phone);
  if (!toNumber) {
    reasons.push({
      code: "INVALID_NUMBER",
      detail: contact.phone
        ? "the contact's phone number is not a valid US number"
        : "contact has no phone number on file",
    });
  }

  // 2) The existing preclearance: agent licensing / AHIP / certs, contact state
  //    + org DNC list, calling hours in the contact's timezone.
  const decision = await runPreclearance({
    orgId: input.orgId,
    agentId: agentId ?? "",
    contactRef: contact.id,
    callee: {
      phone: toNumber ?? contact.phone ?? "",
      stateCode: contact.stateCode ?? undefined,
      zipCode: contact.zipCode ?? undefined,
    },
    callbackUrl: "about:blank",
    productLine,
    // planYear deliberately omitted: preclearance resolves the SELLING plan year
    // (sellingPlanYear) — from October the next year's AHIP/certs are required.
  });
  const preFailures = decision.failures ?? [];
  const agentFailed = !agentId || preFailures.some((f) => AGENT_CODES.has(f.code));
  for (const f of preFailures) {
    // With no agent profile the licensing rows are meaningless; one clear
    // reason replaces them.
    if (!agentId && (AGENT_CODES.has(f.code) || f.code === "MISSING_INPUT")) continue;
    reasons.push({ code: f.code, detail: f.detail });
  }
  if (!agentId) {
    reasons.push({
      code: "AGENT_NOT_ELIGIBLE",
      detail: "no agent profile is linked to you or to this contact, so licensing cannot be verified",
    });
  }

  // 3) DNC across ALL orgs (last-10 match key, any channel). The shared
  //    preclearance rule above only looks inside the caller's own org.
  const optedOut = toNumber
    ? await isNumberOptedOutAnyOrg(toNumber)
    : contact.phone
      ? await isNumberOptedOutAnyOrg(contact.phone)
      : false;
  if (optedOut && !reasons.some((r) => r.code === "DNC")) {
    reasons.push({ code: "DNC", detail: "this number is on a do-not-contact list" });
  }

  // 4) Documented consent (when + where). ALWAYS enforced on the voice path: the
  //    org's `require_sms_consent` switch governs automated SMS only and must
  //    never silently turn off voice consent. Missing/deleted contact is already
  //    NO_CONSENT above.
  const hasConsent = Boolean(contact.tcpaConsentAt && contact.tcpaConsentSource?.trim());
  if (!hasConsent && !reasons.some((r) => r.code === "NO_CONSENT")) {
    reasons.push({
      code: "NO_CONSENT",
      detail: "no documented TCPA consent (date and source) on file for this contact",
    });
  }


  // 5) Attempt limits + cooldown and the insert happen under a per-number lock,
  //    so two parallel clicks cannot both pass the check.
  const lockKey = `call:${input.orgId}:${toNumber ?? contact.id}`;
  const sessionId = randomUUID();
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    // A call whose terminal callback never arrived must not count as live forever.
    await expireStaleLiveSessions(tx, input.orgId, now);

    const limitReasons: BlockReason[] = [];
    const windowStart = new Date(now.getTime() - limits.windowHours * 3_600_000);
    const sameTarget = toNumber
      ? or(eq(callSessionsTable.contactId, contact.id), eq(callSessionsTable.toNumber, toNumber))
      : eq(callSessionsTable.contactId, contact.id);

    // Abandoned attempts (never reached Twilio) don't count toward the limits
    // below, so cap them separately: past the ceiling refuse WITHOUT storing
    // another row, so a scripted client cannot grow the table without bound.
    const [{ n: abandoned = 0 } = {}] = await tx
      .select({ n: count() })
      .from(callSessionsTable)
      .where(
        and(
          eq(callSessionsTable.orgId, input.orgId),
          sameTarget,
          gte(callSessionsTable.createdAt, windowStart),
          sql`${callSessionsTable.twilioCallSid} IS NULL`,
          inArray(callSessionsTable.status, ["initiated", "canceled"]),
        ),
      );
    if (Number(abandoned) >= limits.maxUnclaimedAttempts) {
      return {
        throttled: true,
        reasons: [
          {
            code: "TOO_MANY_ABANDONED_ATTEMPTS",
            detail: `too many call attempts to this number never connected (${Number(abandoned)} in the last ${limits.windowHours} hours, limit ${limits.maxUnclaimedAttempts}); try again later or contact your administrator`,
          },
        ] as BlockReason[],
      } as const;
    }

    const recent = await tx
      .select({ createdAt: callSessionsTable.createdAt })
      .from(callSessionsTable)
      .where(
        and(
          eq(callSessionsTable.orgId, input.orgId),
          sameTarget,
          ne(callSessionsTable.status, "blocked"),
          ne(callSessionsTable.status, "canceled"),
          gte(callSessionsTable.createdAt, windowStart),
          // Only attempts that reached Twilio count. A session that was never
          // claimed (mic denied, hung up while connecting, page closed) dialed
          // nobody; it counts only while it could still be claimed, so two
          // parallel clicks are still caught but an ordinary retry works.
          or(
            isNotNull(callSessionsTable.twilioCallSid),
            gte(callSessionsTable.createdAt, new Date(now.getTime() - CALL_SESSION_TTL_MS)),
          ),
        ),
      );
    if (recent.length >= limits.maxAttempts) {
      limitReasons.push({
        code: "MAX_ATTEMPTS_EXCEEDED",
        detail: `another call to this number happened recently: it was already called ${recent.length} time(s) in the last ${limits.windowHours} hours (limit ${limits.maxAttempts}; counted per phone number, so contacts sharing this number share the limit)`,
      });
    }
    const last = recent.reduce<Date | null>(
      (acc, r) => (!acc || r.createdAt > acc ? r.createdAt : acc),
      null,
    );
    if (last) {
      const readyAt = last.getTime() + limits.redialCooldownMinutes * 60_000;
      if (readyAt > now.getTime()) {
        const mins = Math.ceil((readyAt - now.getTime()) / 60_000);
        limitReasons.push({
          code: "REDIAL_COOLDOWN",
          detail: `redial cooldown: another call to this number happened recently (counted per phone number, so contacts sharing it share the wait) — wait ${mins} more minute(s), minimum gap ${limits.redialCooldownMinutes} minutes`,
        });
      }
    }

    const all = [...reasons, ...limitReasons];
    const blocked = all.length > 0;
    const hasIn = (c: BlockCode): boolean => all.some((r) => r.code === c);
    await tx.insert(callSessionsTable).values({
      id: sessionId,
      orgId: input.orgId,
      contactId: contact.id,
      agentId,
      userId: input.userId,
      direction: "outbound",
      // NOT NULL column: an invalid number is stored as a placeholder that can
      // never be dialed (the row is `blocked`, and the webhook re-validates).
      toNumber: toNumber ?? "invalid",
      fromNumber: callerId,
      status: blocked ? "blocked" : "initiated",
      // Stamped from the same clock the TTL / window checks read, not the DB's.
      createdAt: now,
      updatedAt: now,
      blockedReason: blocked ? all.map((r) => r.code).join(",") : null,
      preclearanceResult: {
        precleared: !blocked,
        checks: {
          numberValid: !hasIn("INVALID_NUMBER"),
          consent: !hasIn("NO_CONSENT"),
          dncClear: !hasIn("DNC"),
          withinCallingHours: hasIn("TIMEZONE_UNRESOLVED") ? null : !hasIn("OUTSIDE_CALLING_HOURS"),
          agentEligible: !agentFailed && !hasIn("AGENT_NOT_ELIGIBLE"),
          attemptLimit: !hasIn("MAX_ATTEMPTS_EXCEEDED"),
          redialCooldown: !hasIn("REDIAL_COOLDOWN"),
        },
        failures: all,
        productLine,
        limits,
        preclearanceId: decision.preclearanceId,
        checkedAt: now.toISOString(),
      },
    });
    return blocked ? ({ blocked: true, reasons: all } as const) : ({ blocked: false } as const);
  });

  if ("throttled" in result) return { kind: "throttled", reasons: result.reasons ?? [] };
  if (result.blocked) {
    return { kind: "blocked", callSessionId: sessionId, reasons: result.reasons ?? [] };
  }
  return { kind: "ok", callSessionId: sessionId, to: toNumber! };
}

// ---- Voice webhook: single-use claim ----------------------------------------

export type ClaimFailure =
  | "not_found"
  | "not_initiated"
  | "expired"
  | "number_mismatch"
  | "identity_mismatch"
  | "invalid_number"
  | "opted_out"
  | "contact_ineligible"
  | "not_outbound"
  | "no_caller_id"
  | "sid_in_use"
  | "raced";

/**
 * Atomically move an `initiated`, unexpired session to `ringing` and bind the
 * Twilio CallSid to it. Exactly one webhook delivery can win; a replay, a
 * second tab, or a forged id all lose.
 */
export async function claimSessionForDial(
  sessionId: string,
  callSid: string,
  now: Date = new Date(),
): Promise<{ ok: true; session: CallSession } | { ok: false; reason: ClaimFailure }> {
  const cutoff = new Date(now.getTime() - CALL_SESSION_TTL_MS);
  try {
    const [claimed] = await db
      .update(callSessionsTable)
      .set({ status: "ringing", twilioCallSid: callSid, startedAt: now })
      .where(
        and(
          eq(callSessionsTable.id, sessionId),
          eq(callSessionsTable.status, "initiated"),
          gte(callSessionsTable.createdAt, cutoff),
        ),
      )
      .returning();
    if (!claimed) return { ok: false, reason: "raced" };
    return { ok: true, session: claimed };
  } catch (err) {
    // Unique violation on twilio_call_sid: that CallSid is already bound.
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "sid_in_use" };
    throw err;
  }
}

/**
 * The browser abandoned an attempt before Twilio ever claimed the session
 * (mic denied, hung up while connecting). Marks it `canceled` so it never
 * counts toward the attempt limit or the redial cooldown, and can never be
 * dialed. A claimed session is left alone.
 */
export async function cancelUnclaimedSession(
  sessionId: string,
  orgId: string,
): Promise<"canceled" | "already_canceled" | "blocked" | "already_used" | "not_found"> {
  const rows = await db
    .update(callSessionsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(callSessionsTable.id, sessionId),
        eq(callSessionsTable.orgId, orgId),
        eq(callSessionsTable.status, "initiated"),
        sql`${callSessionsTable.twilioCallSid} IS NULL`,
      ),
    )
    .returning({ id: callSessionsTable.id });
  if (rows.length > 0) return "canceled";
  const [exists] = await db
    .select({ status: callSessionsTable.status })
    .from(callSessionsTable)
    .where(and(eq(callSessionsTable.id, sessionId), eq(callSessionsTable.orgId, orgId)))
    .limit(1);
  if (!exists) return "not_found";
  if (exists.status === "canceled") return "already_canceled";
  if (exists.status === "blocked") return "blocked"; // never dialable; nothing to cancel
  return "already_used";
}

/** Mark an unused (`initiated`) session blocked. Never touches a used session. */
export async function blockUnusedSession(sessionId: string, reason: string): Promise<boolean> {
  const rows = await db
    .update(callSessionsTable)
    .set({ status: "blocked", blockedReason: `voice_webhook:${reason}` })
    .where(and(eq(callSessionsTable.id, sessionId), eq(callSessionsTable.status, "initiated")))
    .returning({ id: callSessionsTable.id });
  return rows.length > 0;
}

/**
 * Compliance re-check at the moment of dialing (up to CALL_SESSION_TTL_MS after
 * preclearance): a STOP or a do_not_contact change in between must win.
 */
export async function recheckContactAtDial(
  session: CallSession,
): Promise<"ok" | "opted_out" | "contact_ineligible"> {
  if (await isNumberOptedOutAnyOrg(session.toNumber)) return "opted_out";
  if (!session.contactId) return "contact_ineligible";
  const [c] = await db
    .select({ status: contactsTable.status, deletedAt: contactsTable.deletedAt })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, session.contactId), eq(contactsTable.orgId, session.orgId)))
    .limit(1);
  if (!c || c.deletedAt || c.status === "do_not_contact") return "contact_ineligible";
  return "ok";
}

// ---- Status callbacks -------------------------------------------------------

const TWILIO_STATUS_MAP: Record<string, CallSessionStatus> = {
  queued: "initiated",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "in_progress",
  answered: "completed", // <Dial action> DialCallStatus: answered then ended
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled",
};

const TERMINAL: ReadonlySet<CallSessionStatus> = new Set([
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
  "blocked",
]);

function rank(s: CallSessionStatus): number {
  if (TERMINAL.has(s)) return 3;
  if (s === "in_progress") return 2;
  if (s === "ringing") return 1;
  return 0;
}

export function mapTwilioStatus(raw: string | undefined): CallSessionStatus | null {
  return TWILIO_STATUS_MAP[String(raw ?? "").trim().toLowerCase()] ?? null;
}

function clampDuration(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return Math.min(n, 24 * 3600);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const OUTCOME_LABEL: Partial<Record<CallSessionStatus, string>> = {
  completed: "Completed",
  busy: "Busy",
  no_answer: "No answer",
  failed: "Failed",
  canceled: "Canceled",
};

export type StatusUpdateOutcome =
  | { applied: true; status: CallSessionStatus; activityId: string | null }
  | { applied: false; reason: "unknown_call" | "unmapped_status" | "stale_or_duplicate" };

/**
 * Apply one Twilio status event to the session with that CallSid.
 *
 * Idempotent by construction: statuses only move forward (initiated < ringing <
 * in_progress < terminal) and a terminal row is never changed again, so a
 * redelivered or out-of-order callback is a no-op. The row is locked for the
 * duration, so of two concurrent terminal callbacks exactly one writes — and it
 * writes the `call_log` activity in the same transaction, so a call is logged
 * once and only once.
 */
export async function applyStatusUpdate(input: {
  callSid: string;
  twilioStatus: string | undefined;
  durationRaw?: string;
  now?: Date;
}): Promise<StatusUpdateOutcome> {
  const next = mapTwilioStatus(input.twilioStatus);
  if (!next) return { applied: false, reason: "unmapped_status" };
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(callSessionsTable)
      .where(eq(callSessionsTable.twilioCallSid, input.callSid))
      .limit(1)
      .for("update");
    if (!row) return { applied: false, reason: "unknown_call" } as const;

    const current = row.status as CallSessionStatus;
    if (rank(next) <= rank(current) || TERMINAL.has(current)) {
      return { applied: false, reason: "stale_or_duplicate" } as const;
    }

    const patch: Partial<typeof callSessionsTable.$inferInsert> = { status: next };
    if (next === "in_progress" && !row.answeredAt) patch.answeredAt = now;

    let activityId: string | null = null;
    if (TERMINAL.has(next)) {
      patch.endedAt = now;
      const reported = clampDuration(input.durationRaw);
      // A callee leg that completed with talk time proves the call was answered
      // even when no in-progress event was ever delivered. (DO_NOT_CALL relies on
      // `answeredAt`, so it is only ever inferred from callee-leg evidence.)
      // (Either leg: with answerOnBridge the browser leg only answers at the
      // bridge, so its duration is talk time. Zero or missing means NOT answered.)
      if (next === "completed" && !row.answeredAt && reported && reported > 0) {
        patch.answeredAt = new Date(now.getTime() - reported * 1000);
      }
      const computed =
        row.answeredAt != null
          ? Math.max(0, Math.round((now.getTime() - row.answeredAt.getTime()) / 1000))
          : null;
      const duration = next === "completed" || next === "in_progress" ? (reported ?? computed) : (reported ?? 0);
      patch.durationSeconds = duration;

      if (row.contactId) {
        activityId = randomUUID();
        // Never the phone number or any PHI beyond "a call happened".
        await tx.insert(activitiesTable).values({
          id: activityId,
          orgId: row.orgId,
          contactId: row.contactId,
          agentId: row.agentId,
          type: "call_log",
          body:
            `Outbound call — ${OUTCOME_LABEL[next] ?? next}` +
            (duration ? ` (${formatDuration(duration)})` : ""),
          metadata: {
            source: "twilio_voice",
            callSessionId: row.id,
            direction: row.direction,
            outcome: next,
            durationSeconds: duration,
            // Already saved from the browser before this callback arrived.
            ...(row.dispositionCode ? { disposition: row.dispositionCode } : {}),
            ...(row.notes ? { notes: row.notes } : {}),
          },
          createdBy: row.userId,
        });
        patch.activityId = activityId;
      }
    }

    await tx.update(callSessionsTable).set(patch).where(eq(callSessionsTable.id, row.id));
    return { applied: true, status: next, activityId } as const;
  });
}

