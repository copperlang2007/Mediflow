/**
 * Shared "resolve a carrier + state, then route to the best ready-to-sell and
 * available agent" service. Both the Clerk-authed route (routes/queue.ts) and
 * the HMAC-authed public route (routes/queuePublic.ts) call this so the
 * routing policy can never drift between them — they differ only in how the
 * caller is authenticated and how `orgId` is established.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  db,
  agentsTable,
  contactsTable,
  leadRoutingTable,
} from "@workspace/db";
import { resolveCarrier } from "./carriers";
import { getAvailableAgentIds } from "./presence";
import { routeInboundLead, type ReadyToSellAgent } from "./readyToSell";

/**
 * How long a recent `routed` claim counts as in-flight load when ranking the
 * next inbound. Generous enough to cover the gap between routing and an actual
 * assigned-lead row appearing; bounded so it self-clears. 0 disables.
 */
const INFLIGHT_SECONDS = ttlFromEnv("LEAD_QUEUE_INFLIGHT_SECONDS", 120);
/**
 * Idempotency window: a repeat route for the same `(orgId, contactId, carrier)`
 * inside this window replays the original decision instead of routing again
 * (GHL delivers at-least-once). 0 disables.
 */
const IDEMPOTENCY_SECONDS = ttlFromEnv("LEAD_QUEUE_IDEMPOTENCY_SECONDS", 60);

function ttlFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface RouteInboundParams {
  orgId: string;
  carrierId?: string | null;
  carrierName?: string | null;
  contactState?: string | null;
  contactId?: string | null;
  certificationYear?: number;
  requireAhip?: boolean;
  /** Intersect with live presence. Defaults to true. */
  availableOnly?: boolean;
  /** Which channel asked — recorded on the routing claim for the audit trail. */
  source?: "in_app" | "public";
  now?: Date;
}

/**
 * Which routing tier produced the decision (tiered overflow fallback):
 *   - `available`        — a ready-to-sell agent who is currently available
 *     (today's preferred behavior), OR any match made when no presence filter
 *     was applied at all (org hasn't adopted presence / `availableOnly:false`).
 *   - `eligible_offline` — a ready-to-sell agent who is NOT currently available;
 *     a fallback used ONLY when the available tier was empty AND presence
 *     filtering had been applied. Eligibility is never relaxed — the agent is
 *     still active + state-licensed + AHIP-current + carrier-certified.
 *   - `null`             — no agent matched (`no_agent_available`).
 */
export type FallbackTier = "available" | "eligible_offline";

export interface RouteInboundBody {
  status: "routed" | "no_agent_available";
  stateCode: string;
  carrierId: string;
  candidatePool: number;
  agent: ReadyToSellAgent | null;
  /** Whether a live-presence filter was applied to the pool. */
  presenceFiltered: boolean;
  /**
   * Which tier matched this decision: `available` (preferred / no presence
   * filter), `eligible_offline` (presence fallback), or `null` for
   * `no_agent_available`.
   */
  fallbackTier: FallbackTier | null;
  /** Id of the recorded routing claim (or the replayed one). */
  routingId: string;
  /** True when this response replays a prior decision (idempotent retry). */
  idempotent: boolean;
  // Atlas/GHL-compatible flat fields for the "Connect Call" step.
  target_phone: string | null;
  target_user_id: string | null;
}

export type RouteInboundOutcome =
  | { ok: true; body: RouteInboundBody }
  | { ok: false; status: number; error: string };

function normalizeState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  return s.length === 2 ? s : null;
}

const CARRIER_ERROR: Record<
  "missing" | "not_found" | "ambiguous",
  { status: number; error: string }
> = {
  missing: { status: 400, error: "Provide a carrierId or carrierName." },
  not_found: {
    status: 404,
    error: "No active carrier matches the supplied carrierId/carrierName.",
  },
  ambiguous: {
    status: 409,
    error:
      "carrierName matches more than one active carrier — use carrierId to disambiguate.",
  },
};

export async function resolveAndRouteInbound(
  p: RouteInboundParams,
): Promise<RouteInboundOutcome> {
  // 1. Carrier → MediFlow carrier id (org-scoped).
  const carrier = await resolveCarrier({
    orgId: p.orgId,
    carrierId: p.carrierId,
    carrierName: p.carrierName,
  });
  if (!carrier.ok) {
    const mapped = CARRIER_ERROR[carrier.reason];
    return { ok: false, status: mapped.status, error: mapped.error };
  }

  // 2. Lead state: explicit wins, else read from the contact record.
  let state = normalizeState(p.contactState);
  if (!state && p.contactId) {
    const [contact] = await db
      .select({ stateCode: contactsTable.stateCode })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, p.contactId),
          eq(contactsTable.orgId, p.orgId),
        ),
      )
      .limit(1);
    if (!contact) return { ok: false, status: 404, error: "Contact not found" };
    state = normalizeState(contact.stateCode);
  }
  if (!state) {
    return {
      ok: false,
      status: 400,
      error:
        "Could not determine the lead's state — provide `contactState` (2-letter) or a `contactId` whose contact has a stateCode.",
    };
  }

  const now = p.now ?? new Date();

  // 2b. Idempotency — a repeat route for the same contact + carrier inside the
  // window replays the original decision (GHL delivers at-least-once, so a
  // retried webhook must not route the same person to a second agent).
  if (p.contactId && IDEMPOTENCY_SECONDS > 0) {
    const since = new Date(now.getTime() - IDEMPOTENCY_SECONDS * 1000);
    const [prior] = await db
      .select()
      .from(leadRoutingTable)
      .where(
        and(
          eq(leadRoutingTable.orgId, p.orgId),
          eq(leadRoutingTable.contactId, p.contactId),
          eq(leadRoutingTable.carrierId, carrier.carrierId),
          gt(leadRoutingTable.createdAt, since),
        ),
      )
      .orderBy(desc(leadRoutingTable.createdAt))
      .limit(1);
    if (prior) {
      return { ok: true, body: await replayBody(prior) };
    }
  }

  // 3. Live presence. `availableOnly` defaults to true. When the org has no
  // presence rows at all (feature not adopted yet) we DON'T filter, so routing
  // keeps working before any agent has ever checked in. Once presence is in
  // use, an empty available set correctly yields no_agent_available.
  let availableAgentIds: string[] | undefined;
  let presenceFiltered = false;
  if (p.availableOnly !== false) {
    const presence = await getAvailableAgentIds(p.orgId, p.now);
    if (presence.configured) {
      availableAgentIds = presence.ids;
      presenceFiltered = true;
    }
  }

  // 4. Rank ready-to-sell ∩ available, counting recent claims as in-flight
  // load so a burst spreads across the pool, and pick the head.
  const inFlightSince =
    INFLIGHT_SECONDS > 0
      ? new Date(now.getTime() - INFLIGHT_SECONDS * 1000)
      : null;
  const baseQuery = {
    orgId: p.orgId,
    stateCode: state,
    carrierId: carrier.carrierId,
    certificationYear: p.certificationYear,
    requireAhip: p.requireAhip,
    inFlightSince,
    now,
  };

  // Tier 1: ready-to-sell ∩ currently available (today's preferred behavior).
  let result = await routeInboundLead({ ...baseQuery, availableAgentIds });

  // Tier-1 match → `available`. When no presence filter was applied at all (org
  // hasn't adopted presence / `availableOnly:false`), a match is just
  // `available` and there is nothing to fall back to.
  let fallbackTier: FallbackTier | null =
    result.status === "routed" ? "available" : null;

  // Tier 2 (eligible_offline): only when tier 1 found nobody AND presence
  // filtering was actually applied — i.e. the pool was narrowed by who's at
  // their desk. Re-rank the FULL eligible pool (no presence filter) so a
  // qualified-but-offline agent gets the lead rather than it being dropped.
  // Eligibility is NOT relaxed here: routeInboundLead still requires active +
  // state license + AHIP + carrier cert; we only drop the presence intersection.
  if (result.status === "no_agent_available" && presenceFiltered) {
    const fallback = await routeInboundLead({
      ...baseQuery,
      availableAgentIds: undefined,
    });
    if (fallback.status === "routed") {
      result = fallback;
      fallbackTier = "eligible_offline";
    }
  }

  // 5. Record the claim — the audit trail, the in-flight load signal the next
  // route balances on, and the idempotency anchor for retries. `fallbackTier`
  // captures which tier matched (null for no_agent_available).
  const routingId = randomUUID();
  await db.insert(leadRoutingTable).values({
    id: routingId,
    orgId: p.orgId,
    contactId: p.contactId ?? null,
    carrierId: carrier.carrierId,
    stateCode: state,
    certificationYear: p.certificationYear ?? null,
    agentId: result.agent?.agentId ?? null,
    status: result.status,
    candidatePool: result.candidatePool,
    source: p.source ?? null,
    presenceFiltered,
    fallbackTier,
    createdAt: now,
  });

  return {
    ok: true,
    body: {
      status: result.status,
      stateCode: state,
      carrierId: carrier.carrierId,
      candidatePool: result.candidatePool,
      agent: result.agent,
      presenceFiltered,
      fallbackTier,
      routingId,
      idempotent: false,
      target_phone: result.agent?.phone ?? null,
      target_user_id: result.agent?.agentId ?? null,
    },
  };
}

/**
 * Rebuild a response body from a previously-recorded routing claim (idempotent
 * replay). The agent's display fields are re-read so the caller gets a live
 * phone number; load counts are reported as 0 because this is a replay of a
 * past decision, not a fresh ranking.
 */
async function replayBody(
  prior: typeof leadRoutingTable.$inferSelect,
): Promise<RouteInboundBody> {
  let agent: ReadyToSellAgent | null = null;
  if (prior.agentId) {
    const [row] = await db
      .select({
        agentId: agentsTable.id,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        phone: agentsTable.phone,
        npn: agentsTable.npn,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, prior.agentId))
      .limit(1);
    if (row) agent = { ...row, openLeadCount: 0, inFlightCount: 0 };
  }
  return {
    status: prior.status as "routed" | "no_agent_available",
    stateCode: prior.stateCode,
    carrierId: prior.carrierId,
    candidatePool: prior.candidatePool,
    agent,
    presenceFiltered: prior.presenceFiltered,
    fallbackTier: (prior.fallbackTier as FallbackTier | null) ?? null,
    routingId: prior.id,
    idempotent: true,
    target_phone: agent?.phone ?? null,
    target_user_id: agent?.agentId ?? null,
  };
}
