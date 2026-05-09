import { describe, it, expect } from "vitest";
import {
  computePipelineRollup,
  computeStageRollup,
  sumValues,
  type DealForAnalytics,
} from "../pipelineAnalytics";

const SECONDS_PER_DAY = 86_400_000;

function makeDeal(opts: Partial<DealForAnalytics> & { stageId: string; status: DealForAnalytics["status"] }): DealForAnalytics {
  return {
    stageId: opts.stageId,
    status: opts.status,
    valueEst: opts.valueEst ?? null,
    createdAt: opts.createdAt ?? new Date(),
  };
}

describe("sumValues", () => {
  it("adds estimated values, treating null as zero", () => {
    expect(
      sumValues([
        { valueEst: 100 },
        { valueEst: null },
        { valueEst: 50 },
      ]),
    ).toBe(150);
  });

  it("returns 0 for an empty list", () => {
    expect(sumValues([])).toBe(0);
  });
});

describe("computePipelineRollup", () => {
  it("returns zeros for an empty pipeline", () => {
    const r = computePipelineRollup([]);
    expect(r).toEqual({
      totalDeals: 0,
      wonDeals: 0,
      lostDeals: 0,
      openDeals: 0,
      conversionRate: 0,
      openValueTotal: 0,
      wonValueTotal: 0,
      lostValueTotal: 0,
    });
  });

  it("counts and sums by status", () => {
    const r = computePipelineRollup([
      makeDeal({ stageId: "a", status: "open", valueEst: 100 }),
      makeDeal({ stageId: "a", status: "open", valueEst: 200 }),
      makeDeal({ stageId: "b", status: "won", valueEst: 500 }),
      makeDeal({ stageId: "b", status: "won", valueEst: 250 }),
      makeDeal({ stageId: "c", status: "lost", valueEst: 75 }),
    ]);
    expect(r.totalDeals).toBe(5);
    expect(r.openDeals).toBe(2);
    expect(r.wonDeals).toBe(2);
    expect(r.lostDeals).toBe(1);
    expect(r.openValueTotal).toBe(300);
    expect(r.wonValueTotal).toBe(750);
    expect(r.lostValueTotal).toBe(75);
  });

  it("computes conversion rate as won / total, rounded", () => {
    const r = computePipelineRollup([
      makeDeal({ stageId: "x", status: "won" }),
      makeDeal({ stageId: "x", status: "lost" }),
      makeDeal({ stageId: "x", status: "open" }),
    ]);
    // 1 / 3 = 33.33% → rounds to 33
    expect(r.conversionRate).toBe(33);
  });
});

describe("computeStageRollup", () => {
  const now = new Date("2026-01-15T00:00:00Z").getTime();

  it("only counts open deals in a stage", () => {
    const deals: DealForAnalytics[] = [
      makeDeal({ stageId: "qual", status: "open", valueEst: 100, createdAt: new Date(now - 5 * SECONDS_PER_DAY) }),
      makeDeal({ stageId: "qual", status: "won", valueEst: 999 }),
      makeDeal({ stageId: "qual", status: "lost", valueEst: 999 }),
      makeDeal({ stageId: "other", status: "open", valueEst: 200 }),
    ];
    const r = computeStageRollup("qual", deals, now);
    expect(r.dealCount).toBe(1);
    expect(r.totalValue).toBe(100);
    expect(r.avgDaysInStage).toBe(5);
  });

  it("returns zeros when a stage has no open deals", () => {
    const r = computeStageRollup("empty", [], now);
    expect(r.dealCount).toBe(0);
    expect(r.totalValue).toBe(0);
    expect(r.avgDaysInStage).toBe(0);
  });

  it("averages days-in-stage across multiple open deals", () => {
    const deals: DealForAnalytics[] = [
      makeDeal({ stageId: "neg", status: "open", valueEst: 50, createdAt: new Date(now - 2 * SECONDS_PER_DAY) }),
      makeDeal({ stageId: "neg", status: "open", valueEst: 75, createdAt: new Date(now - 8 * SECONDS_PER_DAY) }),
    ];
    const r = computeStageRollup("neg", deals, now);
    expect(r.dealCount).toBe(2);
    expect(r.totalValue).toBe(125);
    expect(r.avgDaysInStage).toBe(5); // (2 + 8) / 2 = 5
  });
});
