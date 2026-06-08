/**
 * Callback SLA queue — capture + auto-resolve for dropped inbounds.
 *
 * When `resolveAndRouteInbound` ends in `no_agent_available`, the lead is
 * captured here as an `open` `lead_callbacks` row with an SLA deadline. A
 * scheduled sweep (`sweepLeadCallbacks`) later re-checks routability and either
 * `resolved`s the row (a ready-to-sell + available agent now exists) or
 * `expired`s it (the SLA passed with still nobody).
 *
 * Both the enqueue and the sweep are deliberately decoupled from the routing
 * hot path: enqueue is best-effort (a failure must never break routing — see
 * `enqueueLeadCallback`), and the sweep is injectable (db + clock + batch) so
 * it is fully testable offline, mirroring lib/dialer/reconcile.ts.
 *
 * Auto-DIALING a resolved callback is intentionally NOT done here. Issuing the
 * outbound call needs dial-ticket issuance + calling-hours/preclearance
 * decisions; this module tracks + resolves the queue only. See the TODO in
 * `resolveOneCallback`.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb, leadCallbacksTable } from "@workspace/db";
import { logger } from "../logger";
import { captureWorkerError } from "../sentry";
import { findReadyToSellAgents } from "./readyToSell";
import { getAvailableAgentIds } from "./presence";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallbackDb = typeof defaultDb | any;

/**
 * SLA window: a captured callback is due `LEAD_QUEUE_CALLBACK_SLA_MINUTES`
 * after it is created. Default 30 minutes.
 */
export const CALLBACK_SLA_MINUTES = minutesFromEnv(
  "LEAD_QUEUE_CALLBACK_SLA_MINUTES",
  30,
);

function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface EnqueueCallbackParams {
  db?: CallbackDb;
  orgId: string;
  contactId?: string | null;
  carrierId: string;
  stateCode: string;
  certificationYear?: number | null;
  now?: Date;
}

/**
 * Capture a dropped inbound as an `open` callback. Best-effort: this is called
 * from the routing path after the routing claim is written, and a failure here
 * must NOT break routing — it is logged + swallowed, never thrown.
 *
 * Dedup: if an `open` callback already exists for the same
 * `(orgId, contactId, carrierId)`, the existing row's SLA is bumped rather than
 * inserting a duplicate. Dedup is skipped when `contactId` is null (no stable
 * key to dedup on — a raw-state inbound always inserts).
 *
 * Returns the callback id (new or bumped), or null on failure / when disabled.
 */
export async function enqueueLeadCallback(
  p: EnqueueCallbackParams,
): Promise<string | null> {
  const db: CallbackDb = p.db ?? defaultDb;
  const now = p.now ?? new Date();
  const slaDueAt = new Date(now.getTime() + CALLBACK_SLA_MINUTES * 60 * 1000);

  try {
    // Dedup on (org, contact, carrier) for contact-bound inbounds: a retried
    // webhook or a second miss for the same person shouldn't stack rows.
    if (p.contactId) {
      const [existing] = await db
        .select({ id: leadCallbacksTable.id })
        .from(leadCallbacksTable)
        .where(
          and(
            eq(leadCallbacksTable.orgId, p.orgId),
            eq(leadCallbacksTable.contactId, p.contactId),
            eq(leadCallbacksTable.carrierId, p.carrierId),
            eq(leadCallbacksTable.status, "open"),
          ),
        )
        .limit(1);
      if (existing) {
        await db
          .update(leadCallbacksTable)
          .set({ slaDueAt, updatedAt: now })
          .where(eq(leadCallbacksTable.id, existing.id));
        return existing.id;
      }
    }

    const id = randomUUID();
    await db.insert(leadCallbacksTable).values({
      id,
      orgId: p.orgId,
      contactId: p.contactId ?? null,
      carrierId: p.carrierId,
      stateCode: p.stateCode,
      certificationYear: p.certificationYear ?? null,
      status: "open",
      slaDueAt,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  } catch (err) {
    // Never let a callback-capture failure break routing.
    logger.error(
      { err, orgId: p.orgId, carrierId: p.carrierId, stateCode: p.stateCode },
      "Lead callback capture failed — routing continues",
    );
    return null;
  }
}

// ---- Re-attempt sweep -------------------------------------------------------

export interface SweepOptions {
  db?: CallbackDb;
  /** Max open callbacks processed in one pass (back-pressure). */
  batchSize?: number;
  now?: () => Date;
}

export interface SweepSummary {
  scanned: number;
  resolved: number;
  expired: number;
  stillOpen: number;
  errors: number;
}

interface OpenCallback {
  id: string;
  orgId: string;
  contactId: string | null;
  carrierId: string;
  stateCode: string;
  certificationYear: number | null;
  slaDueAt: Date;
  attempts: number;
}

/**
 * Re-attempt every `open` callback: if its (carrier, state) now has a
 * ready-to-sell AND available agent, mark it `resolved` (recording that agent);
 * if its SLA has passed with still nobody, mark it `expired`; otherwise leave it
 * `open` (bumping `attempts`/`lastAttemptAt`).
 *
 * Idempotent + safe to re-run: each row is re-evaluated from current state and
 * only ever moves out of `open` once.
 */
export async function sweepLeadCallbacks(
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const db: CallbackDb = opts.db ?? defaultDb;
  const now = (opts.now ?? (() => new Date()))();
  const batchSize = opts.batchSize ?? 200;

  const summary: SweepSummary = {
    scanned: 0,
    resolved: 0,
    expired: 0,
    stillOpen: 0,
    errors: 0,
  };

  const open: OpenCallback[] = await db
    .select({
      id: leadCallbacksTable.id,
      orgId: leadCallbacksTable.orgId,
      contactId: leadCallbacksTable.contactId,
      carrierId: leadCallbacksTable.carrierId,
      stateCode: leadCallbacksTable.stateCode,
      certificationYear: leadCallbacksTable.certificationYear,
      slaDueAt: leadCallbacksTable.slaDueAt,
      attempts: leadCallbacksTable.attempts,
    })
    .from(leadCallbacksTable)
    .where(eq(leadCallbacksTable.status, "open"))
    // SLA-soonest first so the most-overdue work is handled before back-pressure
    // truncates the batch.
    .orderBy(asc(leadCallbacksTable.slaDueAt))
    .limit(batchSize);

  summary.scanned = open.length;
  if (open.length === 0) return summary;

  // Org → live available agent ids, fetched once per org per sweep.
  const availabilityByOrg = new Map<string, string[]>();

  for (const cb of open) {
    try {
      const outcome = await resolveOneCallback(db, cb, availabilityByOrg, now);
      if (outcome === "resolved") summary.resolved++;
      else if (outcome === "expired") summary.expired++;
      else summary.stillOpen++;
    } catch (err) {
      summary.errors++;
      logger.error(
        { err, callbackId: cb.id, orgId: cb.orgId },
        "Lead callback sweep: failed for callback — skipping",
      );
      captureWorkerError(err, {
        worker: "leadCallbackSweep",
        callbackId: cb.id,
      });
    }
  }

  logger.info({ ...summary }, "Lead callback sweep: pass complete");
  return summary;
}

type CallbackOutcome = "resolved" | "expired" | "open";

/**
 * Re-evaluate a single open callback against current routability.
 *
 * Routable = a ready-to-sell agent for (carrier, state) who is ALSO currently
 * available (status='available', unexpired). We compute the ready-to-sell pool
 * and intersect it with live availability — the same two signals the router
 * uses — and resolve to the lightest-loaded such agent (head of the RTS rank).
 */
async function resolveOneCallback(
  db: CallbackDb,
  cb: OpenCallback,
  availabilityByOrg: Map<string, string[]>,
  now: Date,
): Promise<CallbackOutcome> {
  // Live availability for the org (cached per sweep).
  let availableIds = availabilityByOrg.get(cb.orgId);
  if (availableIds === undefined) {
    const presence = await getAvailableAgentIds(cb.orgId, now);
    availableIds = presence.ids;
    availabilityByOrg.set(cb.orgId, availableIds);
  }

  // Ready-to-sell ∩ available for this pair. An empty availableIds short-circuits
  // findReadyToSellAgents to [] (nobody reachable), which is exactly right.
  const pool =
    availableIds.length > 0
      ? await findReadyToSellAgents({
          orgId: cb.orgId,
          stateCode: cb.stateCode,
          carrierId: cb.carrierId,
          certificationYear: cb.certificationYear ?? undefined,
          availableAgentIds: availableIds,
          now,
        })
      : [];

  const attempts = cb.attempts + 1;

  if (pool.length > 0) {
    // Routable now → resolve, recording the agent it would route to (head of
    // the ready-to-sell ranking, i.e. lightest current load).
    //
    // TODO(auto-dial): issuing the actual outbound dial is deferred. It needs
    // dial-ticket issuance + calling-hours / preclearance decisions, which are
    // out of scope here. This feature tracks + resolves the queue; a follow-up
    // wires `resolvedAgentId` into a dial-ticket issuance.
    const resolvedAgentId = pool[0]!.agentId;
    await db
      .update(leadCallbacksTable)
      .set({
        status: "resolved",
        resolvedAt: now,
        resolvedAgentId,
        attempts,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(leadCallbacksTable.id, cb.id),
          // Guard: only act on a row still open (no double-apply under a race).
          eq(leadCallbacksTable.status, "open"),
        ),
      );
    return "resolved";
  }

  if (cb.slaDueAt <= now) {
    // SLA blown and still nobody → expire.
    await db
      .update(leadCallbacksTable)
      .set({
        status: "expired",
        attempts,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(leadCallbacksTable.id, cb.id),
          eq(leadCallbacksTable.status, "open"),
        ),
      );
    return "expired";
  }

  // Still un-routable but within SLA → leave open, record the attempt.
  await db
    .update(leadCallbacksTable)
    .set({ attempts, lastAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(leadCallbacksTable.id, cb.id),
        eq(leadCallbacksTable.status, "open"),
      ),
    );
  return "open";
}

// ---- Admin read + cancel ----------------------------------------------------

export interface CallbackRow {
  id: string;
  orgId: string;
  contactId: string | null;
  carrierId: string;
  carrierName: string | null;
  stateCode: string;
  certificationYear: number | null;
  status: string;
  slaDueAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  resolvedAt: string | null;
  resolvedAgentId: string | null;
  createdAt: string;
}

const CALLBACK_STATUSES = [
  "open",
  "resolved",
  "expired",
  "cancelled",
] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

export interface ListCallbacksParams {
  db?: CallbackDb;
  orgId: string;
  status?: CallbackStatus;
  limit?: number;
}

/**
 * Worked list for the admin Callbacks view: an org's callbacks (optionally
 * filtered by status, default `open`), SLA-soonest first, with the carrier
 * display name joined in.
 */
export async function listLeadCallbacks(
  p: ListCallbacksParams,
): Promise<CallbackRow[]> {
  // Imported lazily-free: carriers table is a plain join; import at top would
  // be fine but keeping the read query self-contained here.
  const { carriersTable } = await import("@workspace/db");
  const db: CallbackDb = p.db ?? defaultDb;
  const status = p.status ?? "open";
  const limit = Math.min(Math.max(1, Math.floor(p.limit ?? 100)), 500);

  const rows = await db
    .select({
      id: leadCallbacksTable.id,
      orgId: leadCallbacksTable.orgId,
      contactId: leadCallbacksTable.contactId,
      carrierId: leadCallbacksTable.carrierId,
      carrierName: carriersTable.name,
      stateCode: leadCallbacksTable.stateCode,
      certificationYear: leadCallbacksTable.certificationYear,
      status: leadCallbacksTable.status,
      slaDueAt: leadCallbacksTable.slaDueAt,
      attempts: leadCallbacksTable.attempts,
      lastAttemptAt: leadCallbacksTable.lastAttemptAt,
      resolvedAt: leadCallbacksTable.resolvedAt,
      resolvedAgentId: leadCallbacksTable.resolvedAgentId,
      createdAt: leadCallbacksTable.createdAt,
    })
    .from(leadCallbacksTable)
    .leftJoin(
      carriersTable,
      eq(carriersTable.id, leadCallbacksTable.carrierId),
    )
    .where(
      and(
        eq(leadCallbacksTable.orgId, p.orgId),
        eq(leadCallbacksTable.status, status),
      ),
    )
    .orderBy(asc(leadCallbacksTable.slaDueAt))
    .limit(limit);

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    orgId: r.orgId as string,
    contactId: (r.contactId as string | null) ?? null,
    carrierId: r.carrierId as string,
    carrierName: (r.carrierName as string | null) ?? null,
    stateCode: r.stateCode as string,
    certificationYear: (r.certificationYear as number | null) ?? null,
    status: r.status as string,
    slaDueAt: toIso(r.slaDueAt),
    attempts: r.attempts as number,
    lastAttemptAt: toIsoOrNull(r.lastAttemptAt),
    resolvedAt: toIsoOrNull(r.resolvedAt),
    resolvedAgentId: (r.resolvedAgentId as string | null) ?? null,
    createdAt: toIso(r.createdAt),
  }));
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(v as string).toISOString();
}
function toIsoOrNull(v: unknown): string | null {
  return v == null ? null : toIso(v);
}

export interface CancelCallbackParams {
  db?: CallbackDb;
  orgId: string;
  id: string;
  now?: Date;
}

/**
 * Cancel an open callback (admin action). Only an `open` row in the caller's org
 * can be cancelled — a resolved/expired/already-cancelled row, or one in
 * another org, is a no-op. Returns true when a row was cancelled.
 */
export async function cancelLeadCallback(
  p: CancelCallbackParams,
): Promise<boolean> {
  const db: CallbackDb = p.db ?? defaultDb;
  const now = p.now ?? new Date();
  const updated = await db
    .update(leadCallbacksTable)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(leadCallbacksTable.id, p.id),
        eq(leadCallbacksTable.orgId, p.orgId),
        eq(leadCallbacksTable.status, "open"),
      ),
    )
    .returning({ id: leadCallbacksTable.id });
  return updated.length > 0;
}

export const __testing = {
  CALLBACK_STATUSES,
  minutesFromEnv,
};
