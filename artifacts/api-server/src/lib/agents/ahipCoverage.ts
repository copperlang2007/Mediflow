/**
 * The ONE definition of AHIP coverage for a certification year.
 *
 *   agents who need AHIP = agents whose status is 'active' OR 'onboarding'
 *                          (suspended / offboarding / offboarded agents are
 *                          not expected to certify)
 *   complete             = an ahip_records row for that year with status
 *                          'passed' or 'waived' — the same "satisfied" set
 *                          the Ready-to-Sell gate uses.
 *
 * Certifications, Renewals, the dashboard and the executive report all read
 * this, so "Active agents 1" (Certifications) can no longer sit beside
 * "0 of 2 agents" (Renewals): both now say "N of 2 agents who need AHIP".
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, agentsTable, ahipRecordsTable } from "@workspace/db";
import { __testing as readyToSellConstants } from "../leadQueue/readyToSell";

export const AHIP_REQUIRED_AGENT_STATUSES = ["active", "onboarding"] as const;
export const AHIP_COMPLETE_STATUSES: readonly string[] =
  readyToSellConstants.CERT_OK_STATUSES;

export interface AhipCoverage {
  year: number;
  /** Agents with status active or onboarding. */
  agentsRequiringAhip: number;
  /** Of those, how many have a passed/waived record for `year`. */
  complete: number;
  /** complete / agentsRequiringAhip × 100, one decimal. 0 when no agents. */
  completionRate: number;
  /** Per-agent status for `year` (null = no record). */
  byAgent: Map<string, string | null>;
}

export function isAhipComplete(status: string | null | undefined): boolean {
  return status != null && AHIP_COMPLETE_STATUSES.includes(status);
}

export async function getAhipCoverage(orgId: string, year: number): Promise<AhipCoverage> {
  const [agents, records] = await Promise.all([
    db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          inArray(agentsTable.status, [...AHIP_REQUIRED_AGENT_STATUSES]),
        ),
      ),
    db
      .select({ agentId: ahipRecordsTable.agentId, status: ahipRecordsTable.status })
      .from(ahipRecordsTable)
      .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          eq(ahipRecordsTable.certificationYear, year),
        ),
      ),
  ]);

  const statusByAgent = new Map<string, string>();
  for (const r of records) {
    // A complete record wins over any other record for the same agent/year.
    if (isAhipComplete(r.status) || !statusByAgent.has(r.agentId)) {
      statusByAgent.set(r.agentId, r.status);
    }
  }

  const byAgent = new Map<string, string | null>();
  let complete = 0;
  for (const a of agents) {
    const st = statusByAgent.get(a.id) ?? null;
    byAgent.set(a.id, st);
    if (isAhipComplete(st)) complete++;
  }
  const agentsRequiringAhip = agents.length;
  const completionRate =
    agentsRequiringAhip > 0 ? Math.round((complete / agentsRequiringAhip) * 1000) / 10 : 0;

  return { year, agentsRequiringAhip, complete, completionRate, byAgent };
}
