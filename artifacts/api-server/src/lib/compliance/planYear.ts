/**
 * Which plan year an agent's AHIP / carrier certifications must cover *today*.
 *
 * Medicare selling is plan-year scoped, not calendar-year scoped. CMS allows
 * marketing of the next contract year from October 1, and AEP (Oct 15 – Dec 7)
 * enrolls beneficiaries into plans effective January 1 of the NEXT year. From
 * October 1 onward an agent is only ready to sell if their AHIP and carrier
 * certifications are for year N+1 — a year-N cert is for plans no longer being
 * marketed to new AEP enrollees.
 *
 * Every certification gate (RTS routing, dialer pre-clearance, the readiness
 * board, compliance scoring, AHIP reminders) resolves its default year here so
 * they can never disagree about which year counts.
 *
 * The cutover is evaluated on the US Eastern calendar date so it flips at
 * midnight Eastern on October 1 rather than 8pm the previous evening (UTC).
 */

/** Month (1-12) on which next-year marketing opens. */
export const NEXT_PLAN_YEAR_MARKETING_MONTH = 10;

function easternDateParts(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return { year, month };
}

/**
 * The plan year being sold on `now`: the calendar year through September 30,
 * the next calendar year from October 1 (Eastern).
 */
export function sellingPlanYear(now: Date = new Date()): number {
  const { year, month } = easternDateParts(now);
  return month >= NEXT_PLAN_YEAR_MARKETING_MONTH ? year + 1 : year;
}

/**
 * The plan year an AHIP certification season is for. The AHIP season opens in
 * the summer and closes around the AEP deadline, and it always certifies agents
 * for the UPCOMING plan year — the 2027 AHIP is taken in mid/late 2026.
 */
export function ahipSeasonPlanYear(now: Date = new Date()): number {
  return easternDateParts(now).year + 1;
}
