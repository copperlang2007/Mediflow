/**
 * Record-retention floor for Medicare Advantage / Part D distribution records.
 *
 * CMS requires MA and Part D contracting entities — and, by contract flow-down,
 * their first-tier, downstream and related entities (agencies, FMOs, TPMOs) —
 * to retain records for 10 years (42 CFR 422.504(d)(2)(iii),
 * 423.505(d)(2)(iii)); TPMO sales/enrollment call recordings carry the same
 * 10-year requirement (42 CFR 422.2274(g)(2)(ii)). No retention policy in this
 * app may delete anything sooner. Orgs can retain LONGER, never shorter.
 */
export const CMS_RECORD_RETENTION_DAYS = 3650;

/** Upper bound accepted from the admin UI (100 years) — rejects typos. */
export const MAX_RETENTION_DAYS = 36_500;

/** The retention window actually enforced for a configured policy. */
export function effectiveRetentionDays(configuredDays: number): number {
  return Math.max(configuredDays, CMS_RECORD_RETENTION_DAYS);
}
