/**
 * Read models for the admin "Live Queue" view — surfacing what the inbound
 * lead queue now records: who is available right now, and the recent routing
 * decisions (`lead_routing` claims). Both are org-scoped, read-only, and join
 * in agent/carrier display names so the route handlers stay thin.
 *
 * Kept separate from readyToSell.ts/service.ts (the routing hot path) because
 * this is purely an oversight surface — no eligibility logic, no writes.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  agentPresenceTable,
  agentsTable,
  leadRoutingTable,
  carriersTable,
} from "@workspace/db";

export interface PresenceAgentRow {
  agentId: string;
  firstName: string;
  lastName: string;
  status: string;
  lastSeenAt: Date;
  expiresAt: Date | null;
  /** True when status is `available` and the TTL has not lapsed. */
  availableNow: boolean;
}

export interface PresenceOverview {
  agents: PresenceAgentRow[];
  /** Count of agents currently routable (availableNow). */
  availableCount: number;
  /** Server clock the TTL was evaluated against (ISO). */
  asOf: string;
}

/**
 * Every presence row for an org, with the live `availableNow` verdict computed
 * against the same read-time TTL the router uses (`available` AND not expired).
 */
export async function getPresenceOverview(
  orgId: string,
  now: Date = new Date(),
): Promise<PresenceOverview> {
  const rows = await db
    .select({
      agentId: agentPresenceTable.agentId,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      status: agentPresenceTable.status,
      lastSeenAt: agentPresenceTable.lastSeenAt,
      expiresAt: agentPresenceTable.expiresAt,
    })
    .from(agentPresenceTable)
    .innerJoin(agentsTable, eq(agentsTable.id, agentPresenceTable.agentId))
    .where(eq(agentPresenceTable.orgId, orgId));

  const agents: PresenceAgentRow[] = rows.map((r) => ({
    ...r,
    availableNow:
      r.status === "available" &&
      (r.expiresAt === null || r.expiresAt > now),
  }));
  // Available first, then by name, for a stable, scannable list.
  agents.sort((a, b) => {
    if (a.availableNow !== b.availableNow) return a.availableNow ? -1 : 1;
    return a.lastName.localeCompare(b.lastName);
  });

  return {
    agents,
    availableCount: agents.filter((a) => a.availableNow).length,
    asOf: now.toISOString(),
  };
}

export interface RoutingDecisionRow {
  id: string;
  createdAt: Date;
  status: string;
  stateCode: string;
  carrierId: string;
  carrierName: string | null;
  agentId: string | null;
  agentFirstName: string | null;
  agentLastName: string | null;
  candidatePool: number;
  source: string | null;
  presenceFiltered: boolean;
}

/** Most-recent routing decisions for an org, newest first (default 50, max 200). */
export async function getRecentRouting(
  orgId: string,
  limit = 50,
): Promise<RoutingDecisionRow[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 200);
  return db
    .select({
      id: leadRoutingTable.id,
      createdAt: leadRoutingTable.createdAt,
      status: leadRoutingTable.status,
      stateCode: leadRoutingTable.stateCode,
      carrierId: leadRoutingTable.carrierId,
      carrierName: carriersTable.name,
      agentId: leadRoutingTable.agentId,
      agentFirstName: agentsTable.firstName,
      agentLastName: agentsTable.lastName,
      candidatePool: leadRoutingTable.candidatePool,
      source: leadRoutingTable.source,
      presenceFiltered: leadRoutingTable.presenceFiltered,
    })
    .from(leadRoutingTable)
    .leftJoin(agentsTable, eq(agentsTable.id, leadRoutingTable.agentId))
    .leftJoin(carriersTable, eq(carriersTable.id, leadRoutingTable.carrierId))
    .where(eq(leadRoutingTable.orgId, orgId))
    .orderBy(desc(leadRoutingTable.createdAt))
    .limit(capped);
}

// ---- Routing analytics ------------------------------------------------------
//
// Window-scoped aggregations over the `lead_routing` audit trail, for the admin
// Analytics view. Everything below is read-only and org-scoped; the window
// (`createdAt >= now - sinceHours`) rides the (org_id, created_at) index.
//
// NOTE: connect latency / speed-to-lead is intentionally NOT computed here — it
// is not derivable from `lead_routing` (which records the routing decision, not
// the dialer's connect/answer timestamps). Surfacing it would require joining
// masterBRIDGE call-lifecycle events (call.initiated → in_progress). TODO once
// those events are persisted queryably per routing decision.

/** Clamp `sinceHours` to the validated range and return the window start. */
function windowStart(sinceHours: number, now: Date): Date {
  const hours = Math.min(Math.max(1, Math.floor(sinceHours)), 720);
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export interface RoutingCarrierBreakdown {
  carrierId: string;
  carrierName: string | null;
  routed: number;
  noAgent: number;
}

export interface RoutingStateBreakdown {
  stateCode: string;
  routed: number;
  noAgent: number;
}

export interface RoutingStats {
  /** Total decisions in the window (routed + no_agent_available). */
  total: number;
  routed: number;
  noAgent: number;
  /** routed / total, 0..1 (0 when no decisions). */
  routedRate: number;
  /** Mean candidatePool across `routed` decisions (0 when none). */
  avgCandidatePool: number;
  byCarrier: RoutingCarrierBreakdown[];
  byState: RoutingStateBreakdown[];
}

/**
 * Aggregate routing outcomes for an org over the last `sinceHours`. One scan of
 * the window builds the totals plus the by-carrier and by-state breakdowns in
 * JS (the row count per window is small — this is an audit trail, not events).
 */
export async function getRoutingStats(
  orgId: string,
  sinceHours: number,
  now: Date = new Date(),
): Promise<RoutingStats> {
  const since = windowStart(sinceHours, now);

  const rows = await db
    .select({
      status: leadRoutingTable.status,
      stateCode: leadRoutingTable.stateCode,
      carrierId: leadRoutingTable.carrierId,
      carrierName: carriersTable.name,
      candidatePool: leadRoutingTable.candidatePool,
    })
    .from(leadRoutingTable)
    .leftJoin(carriersTable, eq(carriersTable.id, leadRoutingTable.carrierId))
    .where(
      and(
        eq(leadRoutingTable.orgId, orgId),
        gte(leadRoutingTable.createdAt, since),
      ),
    );

  let routed = 0;
  let noAgent = 0;
  let routedPoolSum = 0;
  const carriers = new Map<string, RoutingCarrierBreakdown>();
  const states = new Map<string, RoutingStateBreakdown>();

  for (const r of rows) {
    const isRouted = r.status === "routed";
    if (isRouted) {
      routed += 1;
      routedPoolSum += r.candidatePool ?? 0;
    } else {
      noAgent += 1;
    }

    const carrier =
      carriers.get(r.carrierId) ??
      carriers
        .set(r.carrierId, {
          carrierId: r.carrierId,
          carrierName: r.carrierName,
          routed: 0,
          noAgent: 0,
        })
        .get(r.carrierId)!;
    const state =
      states.get(r.stateCode) ??
      states
        .set(r.stateCode, { stateCode: r.stateCode, routed: 0, noAgent: 0 })
        .get(r.stateCode)!;
    if (isRouted) {
      carrier.routed += 1;
      state.routed += 1;
    } else {
      carrier.noAgent += 1;
      state.noAgent += 1;
    }
  }

  const total = routed + noAgent;
  const byCarrier = [...carriers.values()].sort(
    (a, b) =>
      b.routed + b.noAgent - (a.routed + a.noAgent) ||
      (a.carrierName ?? a.carrierId).localeCompare(b.carrierName ?? b.carrierId),
  );
  const byState = [...states.values()].sort(
    (a, b) =>
      b.routed + b.noAgent - (a.routed + a.noAgent) ||
      a.stateCode.localeCompare(b.stateCode),
  );

  return {
    total,
    routed,
    noAgent,
    routedRate: total > 0 ? routed / total : 0,
    avgCandidatePool: routed > 0 ? routedPoolSum / routed : 0,
    byCarrier,
    byState,
  };
}

export interface CoverageGap {
  carrierId: string;
  carrierName: string | null;
  stateCode: string;
  /** `no_agent_available` decisions for this carrier×state in the window. */
  noAgentCount: number;
  /** Most recent `no_agent_available` occurrence (ISO). */
  lastOccurrence: string;
  /**
   * Agents available right now in the ORG (status='available', unexpired) — an
   * org-level hint, NOT a per-pair ready-to-sell recount. 0 here is the loudest
   * coverage alarm: a pair that keeps missing AND nobody is even online.
   */
  availableNow: number;
}

/**
 * Carrier×state pairs that produced `no_agent_available` in the window, ordered
 * by miss count desc. Each carries the live org-level available-agent count so
 * the UI can flag "recurring miss + nobody online" without re-running full RTS
 * eligibility per pair.
 */
export async function getCoverageGaps(
  orgId: string,
  sinceHours: number,
  now: Date = new Date(),
): Promise<CoverageGap[]> {
  const since = windowStart(sinceHours, now);

  const rows = await db
    .select({
      carrierId: leadRoutingTable.carrierId,
      carrierName: carriersTable.name,
      stateCode: leadRoutingTable.stateCode,
      noAgentCount: sql<number>`count(*)`.mapWith(Number),
      lastOccurrence: sql<Date>`max(${leadRoutingTable.createdAt})`,
    })
    .from(leadRoutingTable)
    .leftJoin(carriersTable, eq(carriersTable.id, leadRoutingTable.carrierId))
    .where(
      and(
        eq(leadRoutingTable.orgId, orgId),
        eq(leadRoutingTable.status, "no_agent_available"),
        gte(leadRoutingTable.createdAt, since),
      ),
    )
    .groupBy(
      leadRoutingTable.carrierId,
      carriersTable.name,
      leadRoutingTable.stateCode,
    );

  // Org-level "available right now" — one cheap count reused across all pairs.
  const availRows = await db
    .select({
      expiresAt: agentPresenceTable.expiresAt,
    })
    .from(agentPresenceTable)
    .where(
      and(
        eq(agentPresenceTable.orgId, orgId),
        eq(agentPresenceTable.status, "available"),
      ),
    );
  const availableNow = availRows.filter(
    (r) => r.expiresAt === null || r.expiresAt > now,
  ).length;

  return rows
    .map((r) => ({
      carrierId: r.carrierId,
      carrierName: r.carrierName,
      stateCode: r.stateCode,
      noAgentCount: r.noAgentCount,
      lastOccurrence: new Date(r.lastOccurrence).toISOString(),
      availableNow,
    }))
    .sort(
      (a, b) =>
        b.noAgentCount - a.noAgentCount ||
        b.lastOccurrence.localeCompare(a.lastOccurrence),
    );
}
