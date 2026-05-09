/**
 * Pure helpers for pipeline analytics math. Extracted so the rollup logic
 * used by GET /pipelines/:id/analytics can be unit-tested without spinning
 * up the database.
 */

export type DealForAnalytics = {
  stageId: string;
  status: "open" | "won" | "lost";
  valueEst: number | null;
  createdAt: Date;
};

export function sumValues(rows: { valueEst: number | null }[]): number {
  return rows.reduce((sum, d) => sum + (d.valueEst ?? 0), 0);
}

export function computePipelineRollup(deals: DealForAnalytics[]) {
  const won = deals.filter((d) => d.status === "won");
  const lost = deals.filter((d) => d.status === "lost");
  const open = deals.filter((d) => d.status === "open");
  const totalDeals = deals.length;
  const conversionRate =
    totalDeals > 0 ? Math.round((won.length / totalDeals) * 100) : 0;

  return {
    totalDeals,
    wonDeals: won.length,
    lostDeals: lost.length,
    openDeals: open.length,
    conversionRate,
    openValueTotal: sumValues(open),
    wonValueTotal: sumValues(won),
    lostValueTotal: sumValues(lost),
  };
}

export type StageAnalytic = {
  stageId: string;
  dealCount: number;
  totalValue: number;
  avgDaysInStage: number;
};

export function computeStageRollup(
  stageId: string,
  deals: DealForAnalytics[],
  now: number = Date.now(),
): StageAnalytic {
  const stageDeals = deals.filter(
    (d) => d.stageId === stageId && d.status === "open",
  );
  const totalValue = sumValues(stageDeals);
  const avgDaysInStage =
    stageDeals.length > 0
      ? stageDeals.reduce(
          (sum, d) => sum + Math.floor((now - d.createdAt.getTime()) / 86_400_000),
          0,
        ) / stageDeals.length
      : 0;
  return {
    stageId,
    dealCount: stageDeals.length,
    totalValue,
    avgDaysInStage: Math.round(avgDaysInStage),
  };
}
