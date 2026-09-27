import { describe, it, expect } from "vitest";
import { ahipSeasonPlanYear, sellingPlanYear } from "../planYear";

describe("sellingPlanYear", () => {
  it("is the calendar year through September 30 (Eastern)", () => {
    expect(sellingPlanYear(new Date("2026-01-01T12:00:00Z"))).toBe(2026);
    expect(sellingPlanYear(new Date("2026-09-30T12:00:00Z"))).toBe(2026);
  });

  it("flips to next year at midnight Eastern on October 1", () => {
    // 2026-10-01 03:59Z is still Sept 30, 11:59pm EDT.
    expect(sellingPlanYear(new Date("2026-10-01T03:59:00Z"))).toBe(2026);
    // 2026-10-01 04:00Z is Oct 1, midnight EDT.
    expect(sellingPlanYear(new Date("2026-10-01T04:00:00Z"))).toBe(2027);
  });

  it("stays on next year through AEP and the end of December", () => {
    expect(sellingPlanYear(new Date("2026-10-15T15:00:00Z"))).toBe(2027);
    expect(sellingPlanYear(new Date("2026-12-07T15:00:00Z"))).toBe(2027);
    expect(sellingPlanYear(new Date("2026-12-31T20:00:00Z"))).toBe(2027);
  });

  it("is the new calendar year again from January 1 (Eastern)", () => {
    // Jan 1 02:00Z is still Dec 31 in New York.
    expect(sellingPlanYear(new Date("2027-01-01T02:00:00Z"))).toBe(2027);
    expect(sellingPlanYear(new Date("2027-01-02T12:00:00Z"))).toBe(2027);
  });
});

describe("ahipSeasonPlanYear", () => {
  it("is always the upcoming plan year", () => {
    expect(ahipSeasonPlanYear(new Date("2026-07-01T12:00:00Z"))).toBe(2027);
    expect(ahipSeasonPlanYear(new Date("2026-12-07T12:00:00Z"))).toBe(2027);
  });
});
