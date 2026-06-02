/**
 * Real preclearance (Option A, Phase 4 — spec §2, §9).
 *
 * MediFlow is the single source of truth: every outbound dial is pre-cleared
 * HERE, against MediFlow's own data, before a ticket is ever offered to the
 * dialer. The dialer's `lib/compliance.ts` is only a downstream guardrail
 * (§9) — the DECISION lives in this module.
 *
 * Checks performed (each contributes a machine-readable failure reason):
 *
 *   1. Agent eligibility for the callee's state + product line (§2):
 *        - an ACTIVE, non-expired state license for the callee state;
 *        - for carrier-appointed product lines (MA/PDP/MAPD), AHIP for the
 *          plan year and at least one PASSED carrier certification for the
 *          plan year;
 *      Supplemental / "other" lines do not require AHIP.
 *   2. Consent ledger + DNC (§9):
 *        - the contact must exist, not be soft-deleted, and not be in the
 *          `do_not_contact` status (which is MediFlow's consent-withdrawn /
 *          DNC state);
 *        - no voice/sms `opt_outs` row for the callee phone (DNC list).
 *   3. Calling hours (§9), DST-correct for the callee timezone (derived from
 *        state, IANA zones via `Intl`): the local call time must fall inside
 *        the permitted window (default 08:00–21:00, the TCPA safe harbour).
 *
 * On ANY failure `precleared` is false, the ticket is NOT issued, and the
 * block is audited by the caller (issuance.ts). The MBI never enters this
 * path — only the opaque `contactRef`, phone, state and product line.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  db as defaultDb,
  contactsTable,
  optOutsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
} from "@workspace/db";
import type { IssueTicketInput, PreclearanceDecision } from "./issuance";

/** Machine-readable preclearance failure reasons. */
export type PreclearanceFailureCode =
  | "AGENT_NOT_LICENSED"
  | "AGENT_LICENSE_EXPIRED"
  | "AGENT_NO_AHIP"
  | "AGENT_NOT_CERTIFIED"
  | "NO_CONSENT"
  | "DNC"
  | "OUTSIDE_CALLING_HOURS"
  | "MISSING_INPUT";

export interface PreclearanceFailure {
  code: PreclearanceFailureCode;
  detail: string;
}

/**
 * Minimal drizzle handle so tests can inject the pglite db. Typed against the
 * driver-agnostic `PgDatabase` base so both the production node-postgres
 * handle and the pglite test handle satisfy it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreclearDb = PgDatabase<any, any, any>;

/** Product / plan line carried on the ticket for eligibility checks. */
export type ProductLine = "MA" | "PDP" | "MAPD" | "supp" | "other";

/**
 * Carrier-appointed Medicare lines require AHIP + a passed carrier cert for
 * the plan year. Supplemental / other lines do not.
 */
function requiresAhipAndCert(line: ProductLine): boolean {
  return line === "MA" || line === "PDP" || line === "MAPD";
}

// ---- Calling hours ---------------------------------------------------------

/** TCPA safe-harbour window (local time), inclusive start, exclusive end. */
export const DEFAULT_CALLING_HOURS = { startHour: 8, endHour: 21 } as const;

/**
 * State → IANA timezone. We use the canonical zone for the bulk of each
 * state's population; this is DST-correct via `Intl` regardless of the date.
 * States spanning multiple zones map to their predominant zone — calling
 * hours are intentionally conservative and the dialer re-checks as a
 * backstop (§9).
 */
const STATE_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  DC: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
};

/** Resolve an IANA timezone for the callee (explicit tz wins over state). */
export function resolveTimezone(
  stateCode: string | undefined,
  explicitTz: string | undefined,
): string | null {
  if (explicitTz) return explicitTz;
  if (!stateCode) return null;
  return STATE_TIMEZONE[stateCode.toUpperCase()] ?? null;
}

/**
 * The local hour (0–23) in `timeZone` at instant `at`, DST-correct. Uses
 * `Intl.DateTimeFormat` so the offset (incl. daylight saving) is computed by
 * the platform's tz database rather than a hand-rolled, non-DST table.
 */
export function localHourInZone(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  // `hour12:false` can emit "24" for midnight on some ICU builds.
  const hour = parseInt(hourPart, 10) % 24;
  return Number.isNaN(hour) ? 0 : hour;
}

export function isWithinCallingHours(
  at: Date,
  timeZone: string,
  window: { startHour: number; endHour: number } = DEFAULT_CALLING_HOURS,
): boolean {
  const hour = localHourInZone(at, timeZone);
  return hour >= window.startHour && hour < window.endHour;
}

// ---- Eligibility -----------------------------------------------------------

async function checkAgentEligibility(
  db: PreclearDb,
  opts: {
    agentId: string;
    stateCode: string | undefined;
    productLine: ProductLine;
    planYear: number;
    now: Date;
  },
  failures: PreclearanceFailure[],
): Promise<void> {
  if (!opts.stateCode) {
    failures.push({
      code: "MISSING_INPUT",
      detail: "callee state required for agent eligibility",
    });
    return;
  }
  const state = opts.stateCode.toUpperCase();

  // State licensing: an ACTIVE license for the state that has not expired.
  const licenses = await db
    .select({
      status: stateLicensesTable.status,
      expiryDate: stateLicensesTable.expiryDate,
    })
    .from(stateLicensesTable)
    .where(
      and(
        eq(stateLicensesTable.agentId, opts.agentId),
        eq(stateLicensesTable.stateCode, state),
      ),
    );

  const activeLicenses = licenses.filter((l) => l.status === "active");
  if (activeLicenses.length === 0) {
    failures.push({
      code: "AGENT_NOT_LICENSED",
      detail: `no active ${state} license for agent`,
    });
  } else if (
    activeLicenses.every(
      (l) => l.expiryDate != null && l.expiryDate.getTime() < opts.now.getTime(),
    )
  ) {
    failures.push({
      code: "AGENT_LICENSE_EXPIRED",
      detail: `all ${state} licenses for agent are expired`,
    });
  }

  if (!requiresAhipAndCert(opts.productLine)) return;

  // AHIP for the plan year (status must be passed/waived).
  const ahip = await db
    .select({ status: ahipRecordsTable.status })
    .from(ahipRecordsTable)
    .where(
      and(
        eq(ahipRecordsTable.agentId, opts.agentId),
        eq(ahipRecordsTable.certificationYear, opts.planYear),
      ),
    );
  const ahipOk = ahip.some(
    (a) => a.status === "passed" || a.status === "waived",
  );
  if (!ahipOk) {
    failures.push({
      code: "AGENT_NO_AHIP",
      detail: `no completed AHIP for plan year ${opts.planYear}`,
    });
  }

  // At least one passed/waived carrier certification for the plan year, and
  // not expired where an expiry is recorded.
  const certs = await db
    .select({
      status: carrierCertificationsTable.status,
      expiryDate: carrierCertificationsTable.expiryDate,
    })
    .from(carrierCertificationsTable)
    .where(
      and(
        eq(carrierCertificationsTable.agentId, opts.agentId),
        eq(
          carrierCertificationsTable.certificationYear,
          opts.planYear,
        ),
      ),
    );
  const certOk = certs.some(
    (c) =>
      (c.status === "passed" || c.status === "waived") &&
      (c.expiryDate == null || c.expiryDate.getTime() >= opts.now.getTime()),
  );
  if (!certOk) {
    failures.push({
      code: "AGENT_NOT_CERTIFIED",
      detail: `no valid carrier certification for plan year ${opts.planYear}`,
    });
  }
}

// ---- Consent + DNC ---------------------------------------------------------

async function checkConsentAndDnc(
  db: PreclearDb,
  opts: { orgId: string; contactRef: string; phone: string },
  failures: PreclearanceFailure[],
): Promise<void> {
  const [contact] = await db
    .select({
      status: contactsTable.status,
      deletedAt: contactsTable.deletedAt,
    })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, opts.contactRef),
        eq(contactsTable.orgId, opts.orgId),
      ),
    )
    .limit(1);

  if (!contact || contact.deletedAt != null) {
    failures.push({
      code: "NO_CONSENT",
      detail: "contact not found or deleted — no consent on file",
    });
    return;
  }

  // `do_not_contact` is MediFlow's consent-withdrawn / DNC state.
  if (contact.status === "do_not_contact") {
    failures.push({
      code: "DNC",
      detail: "contact is marked do_not_contact",
    });
    return;
  }

  // DNC list: any opt-out row for this phone in the org (any channel).
  if (opts.phone) {
    const optOut = await db
      .select({ id: optOutsTable.id })
      .from(optOutsTable)
      .where(
        and(
          eq(optOutsTable.orgId, opts.orgId),
          eq(optOutsTable.phone, opts.phone),
        ),
      )
      .limit(1);
    if (optOut.length > 0) {
      failures.push({
        code: "DNC",
        detail: "callee phone is on the org DNC / opt-out list",
      });
    }
  }
}

// ---- Public entrypoint -----------------------------------------------------

export interface RealPreclearOptions {
  db?: PreclearDb;
  nowMs?: () => number;
  ttlSeconds?: number;
  callingHours?: { startHour: number; endHour: number };
}

/**
 * Build a real `PreclearanceDecision` from MediFlow's own data. Wired in as
 * the default preclearance for `DialerIssuanceService` (issuance.ts), and the
 * `config.preclear` override is preserved for tests.
 */
export async function runPreclearance(
  input: IssueTicketInput,
  options: RealPreclearOptions = {},
): Promise<PreclearanceDecision> {
  const db = options.db ?? defaultDb;
  const nowMs = options.nowMs ?? (() => Date.now());
  const ttlSeconds = input.ttlSeconds ?? options.ttlSeconds ?? 30 * 60;
  const now = new Date(nowMs());
  const expires = new Date(now.getTime() + ttlSeconds * 1000);

  const failures: PreclearanceFailure[] = [];

  const productLine: ProductLine = input.productLine ?? "MAPD";
  const planYear = input.planYear ?? now.getUTCFullYear();

  // 1) Agent eligibility (§2).
  await checkAgentEligibility(
    db,
    {
      agentId: input.agentId,
      stateCode: input.callee.stateCode,
      productLine,
      planYear,
      now,
    },
    failures,
  );

  // 2) Consent + DNC (§9).
  await checkConsentAndDnc(
    db,
    {
      orgId: input.orgId,
      contactRef: input.contactRef,
      phone: input.callee.phone,
    },
    failures,
  );

  // 3) Calling hours (§9) — DST-correct per callee timezone.
  const tz = resolveTimezone(input.callee.stateCode, input.calleeTimezone);
  let withinCallingHours = false;
  if (!tz) {
    failures.push({
      code: "OUTSIDE_CALLING_HOURS",
      detail: "could not resolve callee timezone from state/zip",
    });
  } else {
    withinCallingHours = isWithinCallingHours(now, tz, options.callingHours);
    if (!withinCallingHours) {
      failures.push({
        code: "OUTSIDE_CALLING_HOURS",
        detail: `outside permitted calling hours for ${tz}`,
      });
    }
  }

  const has = (code: PreclearanceFailureCode): boolean =>
    failures.some((f) => f.code === code);

  const agentEligible =
    !has("AGENT_NOT_LICENSED") &&
    !has("AGENT_LICENSE_EXPIRED") &&
    !has("AGENT_NO_AHIP") &&
    !has("AGENT_NOT_CERTIFIED") &&
    !has("MISSING_INPUT");
  const tcpaConsentOnFile = !has("NO_CONSENT");
  const dncClear = !has("DNC");

  const precleared = failures.length === 0;

  return {
    precleared,
    preclearedAt: now.toISOString(),
    preclearanceId: `pc_${randomUUID()}`,
    tcpaConsentOnFile,
    dncClear,
    withinCallingHours,
    soaRequired: requiresAhipAndCert(productLine),
    soaOnFile: false,
    agentEligible,
    expiresAt: expires.toISOString(),
    failures,
  };
}
