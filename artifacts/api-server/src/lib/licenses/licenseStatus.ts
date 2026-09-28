/**
 * The ONE definition of whether a state license counts as active or expired.
 *
 * Every surface that counts licenses (Licensing, the agent profile, the
 * Ready-to-Sell board, the agent back office, the dashboard, reports and the
 * compliance score) goes through this module so they can never disagree.
 *
 *   active  = status is 'active'  AND (no expiry date OR expiry is in the future)
 *   expired = expiry date is today-or-earlier (regardless of the stored status),
 *             OR the stored status is already 'expired'
 *
 * The stored `status` column is what an admin last typed; it is not kept in
 * sync with the calendar (nothing flips 'active' to 'expired' at midnight).
 * That is why a license stored as 'active' with an expiry in January reads as
 * expired here — and why pages that only looked at `status` used to say
 * "1/1 active" beside "FL has expired".
 *
 * This mirrors Gate 2 of lib/leadQueue/readyToSell.ts (the inbound router) —
 * `expiry_date > now` is the "still valid" test in both places.
 */
import { and, eq, isNull, lte, or, gt, type SQL, sql } from "drizzle-orm";
import { stateLicensesTable } from "@workspace/db";

export type StoredLicenseStatus =
  | "active"
  | "pending"
  | "expired"
  | "suspended"
  | "not_appointed";

export interface LicenseLike {
  status: string;
  expiryDate: Date | string | null | undefined;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when the license's expiry date has been reached (or status says so). */
export function isLicenseExpired(l: LicenseLike, now: Date = new Date()): boolean {
  if (l.status === "expired") return true;
  const exp = toDate(l.expiryDate);
  return exp != null && exp.getTime() <= now.getTime();
}

/** True when the license lets the agent sell today. */
export function isLicenseActive(l: LicenseLike, now: Date = new Date()): boolean {
  return l.status === "active" && !isLicenseExpired(l, now);
}

/**
 * The status to SHOW. Equal to the stored status except that a license past
 * its expiry date always reads "expired".
 */
export function effectiveLicenseStatus(
  l: LicenseLike,
  now: Date = new Date(),
): StoredLicenseStatus {
  if (isLicenseExpired(l, now)) return "expired";
  return l.status as StoredLicenseStatus;
}

/** Adds `effectiveStatus` to a license row for API responses. */
export function withEffectiveStatus<T extends LicenseLike>(
  l: T,
  now: Date = new Date(),
): T & { effectiveStatus: StoredLicenseStatus } {
  return { ...l, effectiveStatus: effectiveLicenseStatus(l, now) };
}

/** SQL predicate: the license counts as active (see module doc). */
export function activeLicenseWhere(now: Date = new Date()): SQL {
  return and(
    eq(stateLicensesTable.status, "active"),
    or(isNull(stateLicensesTable.expiryDate), gt(stateLicensesTable.expiryDate, now)),
  )!;
}

/** SQL predicate: the license counts as expired (see module doc). */
export function expiredLicenseWhere(now: Date = new Date()): SQL {
  return or(
    eq(stateLicensesTable.status, "expired"),
    lte(stateLicensesTable.expiryDate, now),
  )!;
}

/** SQL CASE expression (1/0) for use inside SUM() aggregates. */
export function activeLicenseFlagSql(now: Date = new Date()): SQL<number> {
  return sql<number>`CASE WHEN ${activeLicenseWhere(now)} THEN 1 ELSE 0 END`;
}
