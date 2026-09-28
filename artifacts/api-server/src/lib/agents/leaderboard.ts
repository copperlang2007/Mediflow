/**
 * Agent activity leaderboard / scorecard — admin oversight ranking the org's
 * agents by inbound-routing activity over a rolling window.
 *
 * Where the readiness board (lib/agents/readiness.ts) answers "who *could*
 * sell" and the inbound router (lib/leadQueue/readyToSell.ts) answers "who gets
 * THIS lead", this answers the operational follow-on: "who has actually been
 * doing the inbound work lately, and how loaded are they right now". It is a
 * pure read model over data the platform already records — no new tables.
 *
 * ## Metrics (per agent)
 *
 *   - `inboundsRouted`    — count of `lead_routing` rows with this agent and
 *                           `status = 'routed'`, `created_at` in the window.
 *                           This is the agent's share of inbound calls the
 *                           smart queue handed them.
 *   - `callbacksResolved` — count of `lead_callbacks` rows whose
 *                           `resolved_agent_id` is this agent and `resolved_at`
 *                           in the window. (The SLA sweep records which agent a
 *                           dropped inbound was re-routed to on resolve.)
 *   - `openLeads`         — point-in-time count of `leads` assigned to the
 *                           agent in an OPEN status. NOT windowed — it is the
 *                           current plate, the same load signal the router
 *                           ranks on. Reuses OPEN_LEAD_STATUSES so the two
 *                           never drift.
 *   - `readyToSell`       — boolean lifted from `getOrgReadiness` (read-only),
 *                           so the leaderboard and the readiness board agree.
 *
 * ## NOT here — close rate / conversion
 *
 * agencyBRIDGE does NOT yet record per-call outcomes or submitted applications, so
 * a true close rate (sales / inbound) is not derivable from existing tables.
 * `leads.status` has a `converted` value, but a converted lead is not the same
 * as a closed *call*, and nothing ties a routed inbound to a downstream sale.
 * Surfacing a "close rate" from this data would be misleading, so it is
 * intentionally omitted (pending an outcomes data source).
 *
 * ## Query shape
 *
 * Scope = the org's agents (status 'active' only — see note below). Three
 * org-scoped grouped aggregates (routed, callbacks, open leads) + one call to
 * `getOrgReadiness`, stitched in JS keyed by agentId. No per-agent N+1.
 *
 * ## Active-only
 *
 * We include only `agents.status = 'active'`. Inactive agents never receive
 * inbound routes (the RTS gate excludes them), so they would always be zero
 * rows and only add noise to an activity ranking. The readiness board, which
 * exists precisely to surface not-yet-active onboarding agents, lists them.
 */
import { and, count, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  agentsTable,
  leadsTable,
  contactsTable,
  leadRoutingTable,
  leadCallbacksTable,
} from "@workspace/db";
import { getOrgReadiness } from "./readiness";
// Single source of truth for "open lead" statuses — shared with the router so
// the leaderboard's open-lead count can never drift from eligibility ranking.
import { OPEN_LEAD_STATUSES } from "../leadQueue/readyToSell";
import { leadContactsWhere } from "../metrics/leads";

export interface AgentLeaderboardEntry {
  agentId: string;
  firstName: string;
  lastName: string;
  status: string;
  /** Inbound `lead_routing` 'routed' claims for this agent in the window. */
  inboundsRouted: number;
  /** `lead_callbacks` rows this agent resolved in the window. */
  callbacksResolved: number;
  /**
   * Open INBOUND-QUEUE leads assigned to the agent (`leads` table, statuses
   * new/contacted/qualified; point-in-time). The routing workload — shown as
   * "Open queue leads". Not the CRM lead count.
   */
  openLeads: number;
  /**
   * CRM contacts with status Lead assigned to the agent (shared definition,
   * lib/metrics/leads.ts) — the number the dashboard and Clients & Leads use.
   */
  leadContacts: number;
  /** Ready-to-sell verdict from getOrgReadiness (read-only). */
  readyToSell: boolean;
  /** 1-based rank after sorting (ties share neighbouring ranks by index). */
  rank: number;
}

export interface AgentLeaderboard {
  data: AgentLeaderboardEntry[];
  /** The rolling window size in hours the activity metrics cover. */
  sinceHours: number;
  /** Server clock the window was computed against (ISO). */
  asOf: string;
}

/**
 * Compute the activity leaderboard for `orgId` over the last `sinceHours`.
 *
 * Ranked by `inboundsRouted` desc, tie-broken by `openLeads` asc (lighter plate
 * ranks higher among equal activity) then `lastName` asc for a deterministic
 * order.
 *
 * @param now Injectable clock for deterministic window math in tests.
 */
export async function getAgentLeaderboard(
  orgId: string,
  sinceHours: number,
  now: Date = new Date(),
): Promise<AgentLeaderboard> {
  const since = new Date(now.getTime() - sinceHours * 60 * 60 * 1000);

  // Scope: the org's ACTIVE agents only (see module doc).
  const agents = await db
    .select({
      agentId: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      status: agentsTable.status,
    })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, orgId), eq(agentsTable.status, "active")));

  if (agents.length === 0) {
    return { data: [], sinceHours, asOf: now.toISOString() };
  }

  const agentIds = agents.map((a) => a.agentId);

  // Inbound routes handed to each agent in the window. Grouped — one row per
  // agent, no N+1. `orgId` leads the predicate so the
  // (org_id, agent_id, created_at) index is usable.
  const routedRows = await db
    .select({
      agentId: leadRoutingTable.agentId,
      n: count(),
    })
    .from(leadRoutingTable)
    .where(
      and(
        eq(leadRoutingTable.orgId, orgId),
        inArray(leadRoutingTable.agentId, agentIds),
        eq(leadRoutingTable.status, "routed"),
        gte(leadRoutingTable.createdAt, since),
      ),
    )
    .groupBy(leadRoutingTable.agentId);

  // Callbacks each agent resolved in the window.
  const callbackRows = await db
    .select({
      agentId: leadCallbacksTable.resolvedAgentId,
      n: count(),
    })
    .from(leadCallbacksTable)
    .where(
      and(
        eq(leadCallbacksTable.orgId, orgId),
        inArray(leadCallbacksTable.resolvedAgentId, agentIds),
        eq(leadCallbacksTable.status, "resolved"),
        gte(leadCallbacksTable.resolvedAt, since),
      ),
    )
    .groupBy(leadCallbacksTable.resolvedAgentId);

  // Current open leads per agent — point-in-time, NOT windowed.
  const openLeadRows = await db
    .select({
      agentId: leadsTable.assignedAgentId,
      n: count(),
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.orgId, orgId),
        inArray(leadsTable.assignedAgentId, agentIds),
        inArray(leadsTable.status, [...OPEN_LEAD_STATUSES]),
      ),
    )
    .groupBy(leadsTable.assignedAgentId);

  // CRM leads per agent (contacts with status Lead) — the shared "lead"
  // definition used by the dashboard and Clients & Leads.
  const leadContactRows = await db
    .select({ agentId: contactsTable.assignedAgentId, n: count() })
    .from(contactsTable)
    .where(and(leadContactsWhere(orgId), inArray(contactsTable.assignedAgentId, agentIds)))
    .groupBy(contactsTable.assignedAgentId);

  // Ready-to-sell verdict — reuse the canonical readiness read model so the two
  // surfaces can never disagree. READ-ONLY; we only consume `readyToSell`.
  const readiness = await getOrgReadiness(orgId, undefined, now);
  const readyByAgent = new Map(
    readiness.agents.map((a) => [a.agentId, a.readyToSell]),
  );

  const routedByAgent = indexCounts(routedRows);
  const callbacksByAgent = indexCounts(callbackRows);
  const openByAgent = indexCounts(openLeadRows);
  const leadContactsByAgent = indexCounts(leadContactRows);

  const entries: Omit<AgentLeaderboardEntry, "rank">[] = agents.map((a) => ({
    agentId: a.agentId,
    firstName: a.firstName,
    lastName: a.lastName,
    status: a.status,
    inboundsRouted: routedByAgent.get(a.agentId) ?? 0,
    callbacksResolved: callbacksByAgent.get(a.agentId) ?? 0,
    openLeads: openByAgent.get(a.agentId) ?? 0,
    leadContacts: leadContactsByAgent.get(a.agentId) ?? 0,
    readyToSell: readyByAgent.get(a.agentId) ?? false,
  }));

  // Most active first; lighter current plate breaks ties; then lastName for a
  // stable, deterministic order.
  entries.sort(
    (a, b) =>
      b.inboundsRouted - a.inboundsRouted ||
      a.openLeads - b.openLeads ||
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  );

  return {
    data: entries.map((e, i) => ({ ...e, rank: i + 1 })),
    sinceHours,
    asOf: now.toISOString(),
  };
}

/** Build an agentId → count map from grouped rows, skipping null agent ids
 * (e.g. a `resolved_agent_id` set NULL by an agent delete). */
function indexCounts(
  rows: { agentId: string | null; n: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.agentId != null) m.set(r.agentId, Number(r.n));
  }
  return m;
}

export const __testing = { OPEN_LEAD_STATUSES };
