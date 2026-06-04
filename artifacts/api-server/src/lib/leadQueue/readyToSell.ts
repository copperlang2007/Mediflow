/**
 * Smart inbound-lead queue — "ready to sell" eligibility + agent ranking.
 *
 * This is the core the inbound router was always missing. The old
 * `atlas-call-router` service accepted `{contact_state, carrier_id}` and
 * returned a HARD-CODED phone number — it had no agent data and no notion of
 * who is actually allowed to sell. All of that lives here in MediFlow, where
 * the agent / license / certification / carrier tables are the system of
 * record.
 *
 * ## "Ready to sell" (RTS) for an agent on a (carrier, state)
 *
 * An agent is RTS for a given carrier in a given state when ALL hold:
 *
 *   1. The agent is employable          — `agents.status = 'active'`.
 *   2. They are licensed in the state    — a `state_licenses` row for that
 *      `state_code` with `status = 'active'` and a non-expired
 *      `expiry_date` (NULL = no expiry on file = treated as valid).
 *   3. They are AHIP-current             — an `ahip_records` row for the
 *      certification year with status `passed`/`waived`. AHIP is the
 *      Medicare prerequisite that gates every carrier cert; callers selling
 *      non-MA products can disable this with `requireAhip: false`.
 *   4. They are certified with the carrier — a `carrier_certifications` row
 *      for that `carrier_id` + certification year with status
 *      `passed`/`waived` and a non-expired `expiry_date`.
 *
 * Each gate is expressed as a correlated `EXISTS` subquery against the
 * `agents` row, so the result set is one row per eligible agent with no join
 * fan-out (an agent licensed in five states still counts once).
 *
 * ## "Smart" ordering
 *
 * Among the eligible pool we rank by current open-lead load ascending — the
 * agent carrying the fewest open leads is offered the next inbound first.
 * That makes the queue self-balancing instead of hammering whoever sorts
 * first alphabetically. Ties break on `lastName` for a stable, deterministic
 * order (important for tests and for fair round-robin under equal load).
 *
 * ## Presence (who is available *right now*)
 *
 * Eligibility answers "may this agent sell?"; it does NOT answer "is the
 * agent at their desk this second?". Real-time presence is supplied by the
 * caller via `availableAgentIds` — the intersection is taken before ranking.
 * See docs/inbound-lead-queue.md for the recommended presence feed (the
 * masterBRIDGE dialer call-state events, which are the authoritative
 * busy/free signal, plus a heartbeat + TTL). Until that feed is wired, omit
 * `availableAgentIds` and the queue ranks the full eligible pool.
 */
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  leadsTable,
  leadRoutingTable,
} from "@workspace/db";

/** Open-lead statuses that count toward an agent's current workload. */
const OPEN_LEAD_STATUSES = ["new", "contacted", "qualified"] as const;

/** Credential statuses that count as "satisfied" for certs/AHIP. */
const CERT_OK_STATUSES = ["passed", "waived"] as const;

export interface ReadyToSellQuery {
  orgId: string;
  /** Two-letter state code of the inbound lead (e.g. "FL"). */
  stateCode: string;
  /** Carrier the lead is being sold (a `carriers.id`). */
  carrierId: string;
  /**
   * Certification year to check certs/AHIP against. Defaults to the current
   * UTC calendar year. Exposed so callers can pin a plan year (Medicare AEP
   * certs for year N+1 are completed in the autumn of year N).
   */
  certificationYear?: number;
  /** Require a current AHIP record. Defaults to true (Medicare path). */
  requireAhip?: boolean;
  /**
   * Real-time presence filter. When provided, only these agent ids are
   * considered (the eligible pool is intersected with this set). An empty
   * array means "nobody is available" and yields an empty result. Omit /
   * `null` to rank the full eligible pool (presence not yet wired).
   */
  availableAgentIds?: readonly string[] | null;
  /**
   * In-flight load window. When set, `routed` lead_routing rows created after
   * this instant count toward each agent's load alongside their open leads —
   * so a burst of inbounds that haven't yet produced assigned-lead rows still
   * spreads across the pool instead of stacking on whoever sorts first. Omit /
   * `null` to rank on open leads only.
   */
  inFlightSince?: Date | null;
  /** Injectable clock for deterministic expiry checks in tests. */
  now?: Date;
}

export interface ReadyToSellAgent {
  agentId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  npn: string | null;
  /** Count of open leads currently assigned to this agent. */
  openLeadCount: number;
  /**
   * Count of recent `routed` claims for this agent within the in-flight window
   * (0 when no window was supplied). Surfaced so callers can see why ordering
   * moved without re-deriving it.
   */
  inFlightCount: number;
}

/**
 * Return every agent who is ready to sell `carrierId` in `stateCode`,
 * ordered best-first (lightest open-lead load, then `lastName`).
 */
export async function findReadyToSellAgents(
  query: ReadyToSellQuery,
): Promise<ReadyToSellAgent[]> {
  const {
    orgId,
    stateCode,
    carrierId,
    certificationYear = new Date().getUTCFullYear(),
    requireAhip = true,
    availableAgentIds,
    inFlightSince,
    now = new Date(),
  } = query;

  // An explicit, empty presence set means nobody is reachable right now —
  // short-circuit before touching the database.
  if (availableAgentIds && availableAgentIds.length === 0) return [];

  // Gate 2 — active, non-expired license in the lead's state. The inner
  // `eq(...agentId, agentsTable.id)` correlates the subquery to the outer
  // agents row (drizzle renders it as a qualified reference).
  const hasStateLicense = exists(
    db
      .select({ one: sql`1` })
      .from(stateLicensesTable)
      .where(
        and(
          eq(stateLicensesTable.agentId, agentsTable.id),
          eq(stateLicensesTable.stateCode, stateCode),
          eq(stateLicensesTable.status, "active"),
          or(
            isNull(stateLicensesTable.expiryDate),
            gt(stateLicensesTable.expiryDate, now),
          ),
        ),
      ),
  );

  // Gate 4 — passed/waived, non-expired carrier cert for the cert year.
  const hasCarrierCert = exists(
    db
      .select({ one: sql`1` })
      .from(carrierCertificationsTable)
      .where(
        and(
          eq(carrierCertificationsTable.agentId, agentsTable.id),
          eq(carrierCertificationsTable.carrierId, carrierId),
          eq(carrierCertificationsTable.certificationYear, certificationYear),
          inArray(carrierCertificationsTable.status, [...CERT_OK_STATUSES]),
          or(
            isNull(carrierCertificationsTable.expiryDate),
            gt(carrierCertificationsTable.expiryDate, now),
          ),
        ),
      ),
  );

  // Gate 3 — current AHIP (optional).
  const hasAhip = exists(
    db
      .select({ one: sql`1` })
      .from(ahipRecordsTable)
      .where(
        and(
          eq(ahipRecordsTable.agentId, agentsTable.id),
          eq(ahipRecordsTable.certificationYear, certificationYear),
          inArray(ahipRecordsTable.status, [...CERT_OK_STATUSES]),
        ),
      ),
  );

  // Ranking key — number of open leads currently on the agent's plate.
  // Embedding the drizzle sub-select (rather than a hand-written string)
  // makes the `assignedAgentId = agents.id` predicate a properly correlated
  // reference to the outer row.
  const openLeadCount = sql<number>`(${db
    .select({ c: count() })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.assignedAgentId, agentsTable.id),
        inArray(leadsTable.status, [...OPEN_LEAD_STATUSES]),
      ),
    )})`;

  // In-flight load — recent `routed` claims not yet reflected as open leads.
  // `sql\`0\`` when no window is supplied, so ordering collapses to open leads
  // and existing (presence-only / read-only) callers are unchanged. The
  // `orgId` predicate is leading so the `(org_id, agent_id, created_at)` index
  // is a usable prefix (agents never change org, so it doesn't alter results).
  const inFlightCount = inFlightSince
    ? sql<number>`(${db
        .select({ c: count() })
        .from(leadRoutingTable)
        .where(
          and(
            eq(leadRoutingTable.orgId, orgId),
            eq(leadRoutingTable.agentId, agentsTable.id),
            eq(leadRoutingTable.status, "routed"),
            gt(leadRoutingTable.createdAt, inFlightSince),
          ),
        )})`
    : sql<number>`0`;

  // Rank by total committed + in-flight load so back-to-back routes balance.
  const effectiveLoad = sql<number>`(${openLeadCount} + ${inFlightCount})`;

  const conditions: SQL[] = [
    eq(agentsTable.orgId, orgId),
    eq(agentsTable.status, "active"),
    hasStateLicense,
    hasCarrierCert,
  ];
  if (requireAhip) conditions.push(hasAhip);
  if (availableAgentIds && availableAgentIds.length > 0) {
    conditions.push(inArray(agentsTable.id, [...availableAgentIds]));
  }

  const rows = await db
    .select({
      agentId: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      phone: agentsTable.phone,
      npn: agentsTable.npn,
      openLeadCount,
      inFlightCount,
    })
    .from(agentsTable)
    .where(and(...conditions))
    .orderBy(asc(effectiveLoad), asc(agentsTable.lastName));

  // pg returns COUNT(*) as a string; normalise to numbers for callers.
  return rows.map((r) => ({
    ...r,
    openLeadCount: Number(r.openLeadCount),
    inFlightCount: Number(r.inFlightCount),
  }));
}

export interface RouteInboundResult {
  /** "routed" when an agent was selected, else "no_agent_available". */
  status: "routed" | "no_agent_available";
  /** Selected agent, or null when the pool was empty. */
  agent: ReadyToSellAgent | null;
  /** Size of the eligible (and available, if filtered) pool. */
  candidatePool: number;
}

/**
 * Pick the single best agent for an inbound lead: the head of the
 * ready-to-sell ranking. Thin wrapper so callers (the GHL-facing route, an
 * automation, a worker) share one selection policy.
 */
export async function routeInboundLead(
  query: ReadyToSellQuery,
): Promise<RouteInboundResult> {
  const pool = await findReadyToSellAgents(query);
  return {
    status: pool.length > 0 ? "routed" : "no_agent_available",
    agent: pool[0] ?? null,
    candidatePool: pool.length,
  };
}

export const __testing = { OPEN_LEAD_STATUSES, CERT_OK_STATUSES };
