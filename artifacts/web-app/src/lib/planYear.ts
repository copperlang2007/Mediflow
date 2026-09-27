/**
 * Plan year being sold today — the calendar year through September 30, the
 * next year from October 1 (US Eastern), when AEP marketing opens.
 *
 * Mirrors artifacts/api-server/src/lib/compliance/planYear.ts so form defaults
 * and filters match the year the server scores credentials against.
 */
export function sellingPlanYear(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return month >= 10 ? year + 1 : year;
}
