/**
 * Read models for the admin "Live Queue" view — surfacing what the inbound
 * lead queue now records: who is available right now, and the recent routing
 * decisions (`lead_routing` claims). Both are org-scoped, read-only, and join
 * in agent/carrier display names so the route handlers stay thin.
 *
 * Kept separate from readyToSell.ts/service.ts (the routing hot path) because
 * this is purely an oversight surface — no eligibility logic, no writes.
 */
import { desc, eq } from "drizzle-orm";
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
