/**
 * Web side of the shared license definition (the source of truth is the API:
 * artifacts/api-server/src/lib/licenses/licenseStatus.ts, which stamps
 * `effectiveStatus` on every license it returns).
 *
 *   active  = status active AND (no expiry OR expiry in the future)
 *   expired = expiry date reached (regardless of stored status) OR status expired
 *
 * Pages read `effectiveStatus` when present. The fallback below applies the
 * identical rule for any older payload that lacks it, so a page can never
 * count "active" differently from Ready to Sell again.
 */
export type LicenseStatusValue = "active" | "pending" | "expired" | "suspended" | "not_appointed";

export interface LicenseLike {
  status: string;
  expiryDate?: string | null;
  effectiveStatus?: string | null;
}

export function licenseEffectiveStatus(l: LicenseLike, now: Date = new Date()): LicenseStatusValue {
  if (l.effectiveStatus) return l.effectiveStatus as LicenseStatusValue;
  if (l.status === "expired") return "expired";
  if (l.expiryDate) {
    const exp = new Date(l.expiryDate);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) return "expired";
  }
  return l.status as LicenseStatusValue;
}

export function isLicenseActive(l: LicenseLike, now: Date = new Date()): boolean {
  return licenseEffectiveStatus(l, now) === "active";
}

export function isLicenseExpired(l: LicenseLike, now: Date = new Date()): boolean {
  return licenseEffectiveStatus(l, now) === "expired";
}

/** Whole days until expiry (negative once expired), or null with no date. */
export function daysUntilExpiry(l: LicenseLike, now: Date = new Date()): number | null {
  if (!l.expiryDate) return null;
  const exp = new Date(l.expiryDate);
  if (Number.isNaN(exp.getTime())) return null;
  return Math.ceil((exp.getTime() - now.getTime()) / 86_400_000);
}
