/**
 * Proactive "Credentials expiring soon" early-warning read model.
 *
 * The readiness board (lib/agents/readiness.ts) shows what *currently* blocks an
 * agent from selling; the RTS eligibility gate (lib/leadQueue/readyToSell.ts)
 * already excludes EXPIRED credentials from the routable pool automatically. So
 * by the time a credential lapses the agent has already silently dropped out.
 *
 * This module is the forward-looking complement: for an org's ACTIVE agents,
 * which credentials are about to expire (in the future, but within `withinDays`)
 * so admins can act BEFORE the lapse auto-pauses the agent. It mirrors the gate
 * semantics of readyToSell.ts / readiness.ts exactly — only `active`-status
 * licenses and `passed`/`waived` carrier certs "count", so a credential the
 * agent has already abandoned (suspended license, failed cert) never shows up as
 * "expiring".
 *
 * ## AHIP
 *
 * `ahip_records` has NO row-level expiry/deadline column — AHIP is plan-year
 * scoped (an agent is "current" by having a passed/waived row for the cert
 * year). The deadline itself lives in org settings (`ahipDeadlineMonth` /
 * `ahipDeadlineDay`) and is driven by the AHIP_DEADLINE_CHECK cron, not a
 * per-record date. There is therefore no per-credential `expiryDate` to compute
 * `daysUntil` against, so AHIP is intentionally OUT of this view (its early
 * warning is the existing season/deadline reminder cron). We keep the
 * `"ahip"` type in the union so a future schema that adds an AHIP date can slot
 * in without an API break.
 *
 * ## Query shape
 *
 * Two org-scoped, grouped queries (licenses + carrier certs, each joined to the
 * agents row for org-scoping + name and — for certs — carriers for the label),
 * stitched + sorted in JS. No per-agent N+1.
 */
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
} from "@workspace/db";
import { __testing as readyToSellConstants } from "../leadQueue/readyToSell";

/** Credential statuses that count as "satisfied" for certs (passed/waived). */
const CERT_OK_STATUSES = readyToSellConstants.CERT_OK_STATUSES;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CredentialType = "license" | "carrier_cert" | "ahip";

/**
 * Urgency tier derived from `daysUntil`. Ordered most→least urgent. `expired`
 * is reserved for already-lapsed creds — this view focuses on UPCOMING expiries
 * so it is not currently emitted (the RTS gate already drops expired creds), but
 * the tier exists for callers that want lapsed rows.
 */
export type ExpiryTier = "expired" | "critical" | "soon" | "upcoming";

export interface ExpiringCredential {
  agentId: string;
  agentName: string;
  type: CredentialType;
  /** State code (license) / carrier name (cert) / cert year (ahip). */
  label: string;
  /** ISO timestamp of the credential's expiry. */
  expiryDate: string;
  /** Whole days from `now` until expiry (ceil; ≥1 for everything returned). */
  daysUntil: number;
  tier: ExpiryTier;
}

export interface CredentialExpiryCounts {
  critical: number;
  soon: number;
  upcoming: number;
}

export interface ExpiringCredentialsResult {
  data: ExpiringCredential[];
  withinDays: number;
  /** Server clock the window was evaluated against (ISO). */
  asOf: string;
  counts: CredentialExpiryCounts;
}

/** Bucket a positive `daysUntil` into its urgency tier. */
export function tierForDaysUntil(daysUntil: number): ExpiryTier {
  if (daysUntil < 0) return "expired";
  if (daysUntil <= 7) return "critical";
  if (daysUntil <= 30) return "soon";
  return "upcoming";
}

/** Whole days until `expiry`, rounded UP so "expires in 4.2 days" reads as 5. */
function daysUntil(expiry: Date, now: Date): number {
  return Math.ceil((expiry.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Credentials for `orgId`'s ACTIVE agents whose expiry falls in the future but
 * within `withinDays` days. Soonest-expiry first.
 *
 * @param withinDays Forward window in days (inclusive upper bound).
 * @param now Injectable clock for deterministic tests.
 */
export async function getExpiringCredentials(
  orgId: string,
  withinDays: number,
  now: Date = new Date(),
): Promise<ExpiringCredentialsResult> {
  const cutoff = new Date(now.getTime() + withinDays * MS_PER_DAY);

  // Active, non-expired-yet licenses for the org's ACTIVE agents, expiring in
  // the (now, cutoff] window. Same status gate as readyToSell.ts Gate 2; the
  // inner join to agents both org-scopes the query and supplies the name.
  const licenseRows = await db
    .select({
      agentId: stateLicensesTable.agentId,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      label: stateLicensesTable.stateCode,
      expiryDate: stateLicensesTable.expiryDate,
    })
    .from(stateLicensesTable)
    .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
    .where(
      and(
        eq(agentsTable.orgId, orgId),
        eq(agentsTable.status, "active"),
        eq(stateLicensesTable.status, "active"),
        gt(stateLicensesTable.expiryDate, now),
        lte(stateLicensesTable.expiryDate, cutoff),
      ),
    );

  // Passed/waived, non-expired-yet carrier certs in the window — Gate 4. Joined
  // to carriers for the display label.
  const certRows = await db
    .select({
      agentId: carrierCertificationsTable.agentId,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      label: carriersTable.name,
      expiryDate: carrierCertificationsTable.expiryDate,
    })
    .from(carrierCertificationsTable)
    .innerJoin(
      agentsTable,
      eq(carrierCertificationsTable.agentId, agentsTable.id),
    )
    .innerJoin(
      carriersTable,
      eq(carriersTable.id, carrierCertificationsTable.carrierId),
    )
    .where(
      and(
        eq(agentsTable.orgId, orgId),
        eq(agentsTable.status, "active"),
        inArray(carrierCertificationsTable.status, [...CERT_OK_STATUSES]),
        gt(carrierCertificationsTable.expiryDate, now),
        lte(carrierCertificationsTable.expiryDate, cutoff),
      ),
    );

  const data: ExpiringCredential[] = [];

  for (const r of licenseRows) {
    // expiryDate is non-null here (the `gt` predicate excludes NULLs in SQL).
    const expiry = r.expiryDate as Date;
    const d = daysUntil(expiry, now);
    data.push({
      agentId: r.agentId,
      agentName: `${r.firstName} ${r.lastName}`,
      type: "license",
      label: r.label,
      expiryDate: expiry.toISOString(),
      daysUntil: d,
      tier: tierForDaysUntil(d),
    });
  }

  for (const r of certRows) {
    const expiry = r.expiryDate as Date;
    const d = daysUntil(expiry, now);
    data.push({
      agentId: r.agentId,
      agentName: `${r.firstName} ${r.lastName}`,
      type: "carrier_cert",
      label: r.label,
      expiryDate: expiry.toISOString(),
      daysUntil: d,
      tier: tierForDaysUntil(d),
    });
  }

  // Soonest expiry first; stable tiebreak on name then label so the ordering is
  // deterministic for tests and for a calm UI.
  data.sort(
    (a, b) =>
      a.daysUntil - b.daysUntil ||
      a.agentName.localeCompare(b.agentName) ||
      a.label.localeCompare(b.label),
  );

  const counts: CredentialExpiryCounts = { critical: 0, soon: 0, upcoming: 0 };
  for (const c of data) {
    if (c.tier === "critical") counts.critical++;
    else if (c.tier === "soon") counts.soon++;
    else if (c.tier === "upcoming") counts.upcoming++;
  }

  return { data, withinDays, asOf: now.toISOString(), counts };
}
