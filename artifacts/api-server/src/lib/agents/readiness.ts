/**
 * Agent "Ready to Sell" readiness board — the admin-facing inverse of the
 * inbound router's eligibility predicate.
 *
 * `lib/leadQueue/readyToSell.ts` answers a single, lead-shaped question: "who
 * may sell THIS carrier in THIS state right now?" (a correlated set of EXISTS
 * gates filtered down to a routable pool). This module answers the
 * onboarding-shaped inverse: for EVERY agent in the org, what makes them
 * ready-to-sell and — when they aren't — what is blocking them. Admins use it
 * to drive onboarding completion and grow the routable pool.
 *
 * ## Readiness (org-wide, carrier/state-agnostic)
 *
 * An agent is "ready to sell" here when they could sell SOMETHING — i.e. they
 * clear the universal gates plus have at least one of each carrier-/state-
 * scoped credential:
 *
 *   - `active`         — `agents.status = 'active'`.
 *   - `ahipCurrent`    — an `ahip_records` row for the cert year, status
 *                        passed/waived (the Medicare prerequisite).
 *   - `licensedStates` — ≥1 `state_licenses` row with status 'active' and a
 *                        non-expired `expiry_date` (NULL expiry = valid).
 *   - `certifiedCarriers` — ≥1 `carrier_certifications` row for the cert year
 *                        with status passed/waived and a non-expired
 *                        `expiry_date` (NULL = valid).
 *
 * `readyToSell = active && ahipCurrent && licensedStates ≥ 1 && certifiedCarriers ≥ 1`.
 *
 * This mirrors readyToSell.ts's per-gate semantics exactly (statuses, expiry
 * handling, cert year) but is *aggregate* rather than carrier×state-pinned: a
 * ready agent here is one for whom SOME (carrier, state) pair would pass the
 * router; the specific pairs are surfaced as `licensedStates` /
 * `certifiedCarriers` so admins can see the actual coverage.
 *
 * ## Query shape
 *
 * Four org-scoped queries (agents + the three credential tables grouped),
 * stitched in JS — no per-agent N+1. The credential queries are filtered to
 * the same statuses/expiry the gates use, so a row only appears if it
 * "counts".
 */
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  carriersTable,
} from "@workspace/db";
// Reuse the canonical "satisfied" status set from the router predicate so the
// two can never drift (read-only import — we do not change its behaviour).
import { __testing as readyToSellConstants } from "../leadQueue/readyToSell";

/** Credential statuses that count as "satisfied" for certs/AHIP. */
const CERT_OK_STATUSES = readyToSellConstants.CERT_OK_STATUSES;

export interface CertifiedCarrier {
  carrierId: string;
  name: string | null;
}

export interface AgentReadiness {
  agentId: string;
  firstName: string;
  lastName: string;
  npn: string | null;
  status: string;
  /** `agents.status === 'active'`. */
  active: boolean;
  /** Passed/waived AHIP record for the cert year. */
  ahipCurrent: boolean;
  /** Distinct state codes with an active, non-expired license. */
  licensedStates: string[];
  /** Carriers with a passed/waived, non-expired cert for the cert year. */
  certifiedCarriers: CertifiedCarrier[];
  /** active && ahipCurrent && ≥1 licensedState && ≥1 certifiedCarrier. */
  readyToSell: boolean;
  /** Human-readable reasons the agent is NOT ready (empty when ready). */
  blockers: string[];
}

export interface OrgReadiness {
  agents: AgentReadiness[];
  /** Count of agents with `readyToSell === true`. */
  readyCount: number;
  /** Total agents considered. */
  totalCount: number;
  /** Certification year the AHIP/cert gates were evaluated against. */
  certificationYear: number;
  /** Server clock the expiry checks ran against (ISO). */
  asOf: string;
}

// Blocker copy — single source so the UI chips and the tests agree.
export const BLOCKER = {
  INACTIVE: "Inactive",
  AHIP: "AHIP not current",
  LICENSE: "No active state license",
  CARRIER: "No carrier certifications",
} as const;

/**
 * Compute readiness for every agent in `orgId`.
 *
 * @param certificationYear AHIP/cert year to evaluate. Defaults to the current
 *   UTC calendar year (matches readyToSell.ts).
 * @param now Injectable clock for deterministic expiry checks in tests.
 */
export async function getOrgReadiness(
  orgId: string,
  certificationYear: number = new Date().getUTCFullYear(),
  now: Date = new Date(),
): Promise<OrgReadiness> {
  // One row per agent in the org.
  const agents = await db
    .select({
      agentId: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      npn: agentsTable.npn,
      status: agentsTable.status,
    })
    .from(agentsTable)
    .where(eq(agentsTable.orgId, orgId));

  if (agents.length === 0) {
    return {
      agents: [],
      readyCount: 0,
      totalCount: 0,
      certificationYear,
      asOf: now.toISOString(),
    };
  }

  const agentIds = agents.map((a) => a.agentId);

  // Active, non-expired licenses (org's agents only) — same gate as
  // readyToSell.ts Gate 2. Joined back to agents via the agentId IN (...) set
  // so we stay org-scoped without re-joining the agents table.
  const licenseRows = await db
    .select({
      agentId: stateLicensesTable.agentId,
      stateCode: stateLicensesTable.stateCode,
    })
    .from(stateLicensesTable)
    .where(
      and(
        inArray(stateLicensesTable.agentId, agentIds),
        eq(stateLicensesTable.status, "active"),
        or(
          isNull(stateLicensesTable.expiryDate),
          gt(stateLicensesTable.expiryDate, now),
        ),
      ),
    );

  // Passed/waived, non-expired carrier certs for the cert year — Gate 4. Join
  // carriers for the display name.
  const certRows = await db
    .select({
      agentId: carrierCertificationsTable.agentId,
      carrierId: carrierCertificationsTable.carrierId,
      carrierName: carriersTable.name,
    })
    .from(carrierCertificationsTable)
    .leftJoin(
      carriersTable,
      eq(carriersTable.id, carrierCertificationsTable.carrierId),
    )
    .where(
      and(
        inArray(carrierCertificationsTable.agentId, agentIds),
        eq(carrierCertificationsTable.certificationYear, certificationYear),
        inArray(carrierCertificationsTable.status, [...CERT_OK_STATUSES]),
        or(
          isNull(carrierCertificationsTable.expiryDate),
          gt(carrierCertificationsTable.expiryDate, now),
        ),
      ),
    );

  // Passed/waived AHIP for the cert year — Gate 3.
  const ahipRows = await db
    .select({ agentId: ahipRecordsTable.agentId })
    .from(ahipRecordsTable)
    .where(
      and(
        inArray(ahipRecordsTable.agentId, agentIds),
        eq(ahipRecordsTable.certificationYear, certificationYear),
        inArray(ahipRecordsTable.status, [...CERT_OK_STATUSES]),
      ),
    );

  // Index the credential rows by agent.
  const statesByAgent = new Map<string, Set<string>>();
  for (const r of licenseRows) {
    let set = statesByAgent.get(r.agentId);
    if (!set) statesByAgent.set(r.agentId, (set = new Set()));
    set.add(r.stateCode);
  }

  const carriersByAgent = new Map<string, Map<string, string | null>>();
  for (const r of certRows) {
    let m = carriersByAgent.get(r.agentId);
    if (!m) carriersByAgent.set(r.agentId, (m = new Map()));
    // First name wins; a missing carrier row leaves the name null.
    if (!m.has(r.carrierId)) m.set(r.carrierId, r.carrierName);
  }

  const ahipByAgent = new Set(ahipRows.map((r) => r.agentId));

  const result: AgentReadiness[] = agents.map((a) => {
    const active = a.status === "active";
    const ahipCurrent = ahipByAgent.has(a.agentId);
    const licensedStates = [...(statesByAgent.get(a.agentId) ?? [])].sort();
    const certifiedCarriers: CertifiedCarrier[] = [
      ...(carriersByAgent.get(a.agentId) ?? new Map()),
    ]
      .map(([carrierId, name]) => ({ carrierId, name }))
      .sort((x, y) =>
        (x.name ?? x.carrierId).localeCompare(y.name ?? y.carrierId),
      );

    const readyToSell =
      active &&
      ahipCurrent &&
      licensedStates.length > 0 &&
      certifiedCarriers.length > 0;

    const blockers: string[] = [];
    if (!active) blockers.push(BLOCKER.INACTIVE);
    if (!ahipCurrent) blockers.push(BLOCKER.AHIP);
    if (licensedStates.length === 0) blockers.push(BLOCKER.LICENSE);
    if (certifiedCarriers.length === 0) blockers.push(BLOCKER.CARRIER);

    return {
      agentId: a.agentId,
      firstName: a.firstName,
      lastName: a.lastName,
      npn: a.npn,
      status: a.status,
      active,
      ahipCurrent,
      licensedStates,
      certifiedCarriers,
      readyToSell,
      blockers,
    };
  });

  // Not-ready first (so admins see the onboarding work up top), then lastName.
  result.sort((a, b) => {
    if (a.readyToSell !== b.readyToSell) return a.readyToSell ? 1 : -1;
    return (
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName)
    );
  });

  return {
    agents: result,
    readyCount: result.filter((a) => a.readyToSell).length,
    totalCount: result.length,
    certificationYear,
    asOf: now.toISOString(),
  };
}
