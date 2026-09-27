import { describe, it, expect } from "vitest";
import { isWithinContactHours, nextContactWindowStart } from "../quietHours";
import { phoneMatchKey } from "../phone";

// All instants below are in September/October 2026 (EDT = UTC-4, CDT = UTC-5,
// MDT = UTC-6, PDT = UTC-7).
describe("isWithinContactHours", () => {
  it("allows the federal 8am–9pm window in a single-zone state", () => {
    expect(isWithinContactHours("GA", new Date("2026-09-28T12:00:00Z"))).toBe(true); // 8:00am EDT
    expect(isWithinContactHours("GA", new Date("2026-09-29T00:59:00Z"))).toBe(true); // 8:59pm EDT
    expect(isWithinContactHours("GA", new Date("2026-09-29T01:00:00Z"))).toBe(false); // 9:00pm EDT
    expect(isWithinContactHours("GA", new Date("2026-09-28T11:59:00Z"))).toBe(false); // 7:59am EDT
  });

  it("applies Florida's 8pm cutoff in both of its time zones", () => {
    // 8:30pm EDT = 7:30pm CDT in the panhandle — still past 8pm on the east coast.
    expect(isWithinContactHours("FL", new Date("2026-09-29T00:30:00Z"))).toBe(false);
    // 7:30pm EDT = 6:30pm CDT — inside the window everywhere in the state.
    expect(isWithinContactHours("FL", new Date("2026-09-28T23:30:00Z"))).toBe(true);
    // 8:15am EDT = 7:15am CDT — panhandle not open yet.
    expect(isWithinContactHours("FL", new Date("2026-09-28T12:15:00Z"))).toBe(false);
  });

  it("applies Texas's Sunday noon start", () => {
    // Sunday 2026-09-27: 10:00am CDT.
    expect(isWithinContactHours("TX", new Date("2026-09-27T15:00:00Z"))).toBe(false);
    // Sunday 1:30pm CDT = 12:30pm MDT (El Paso) — open everywhere.
    expect(isWithinContactHours("TX", new Date("2026-09-27T18:30:00Z"))).toBe(true);
    // Monday 10:30am CDT = 9:30am MDT.
    expect(isWithinContactHours("TX", new Date("2026-09-28T15:30:00Z"))).toBe(true);
  });

  it("requires every continental zone to be open when the state is unknown", () => {
    // 9:00am EDT = 6:00am PDT.
    expect(isWithinContactHours(null, new Date("2026-09-28T13:00:00Z"))).toBe(false);
    // 1:00pm EDT = 10:00am PDT.
    expect(isWithinContactHours(undefined, new Date("2026-09-28T17:00:00Z"))).toBe(true);
    // 9:30pm EDT = 6:30pm PDT — too late on the east coast.
    expect(isWithinContactHours("", new Date("2026-09-29T01:30:00Z"))).toBe(false);
  });
});

describe("nextContactWindowStart", () => {
  it("returns now when already inside the window", () => {
    const now = new Date("2026-09-28T16:07:00Z");
    expect(nextContactWindowStart("GA", now)).toEqual(now);
  });

  it("returns the next morning's opening for a late-evening send", () => {
    // 10:05pm EDT → 8:00am EDT next day.
    const next = nextContactWindowStart("GA", new Date("2026-09-29T02:05:00Z"));
    expect(next.toISOString()).toBe("2026-09-29T12:00:00.000Z");
  });

  it("waits for the latest zone to open in a split state", () => {
    // Florida 6:00am EDT → panhandle opens at 8:00am CDT = 9:00am EDT.
    const next = nextContactWindowStart("FL", new Date("2026-09-28T10:00:00Z"));
    expect(next.toISOString()).toBe("2026-09-28T13:00:00.000Z");
  });
});

describe("phoneMatchKey", () => {
  it("matches the same number across formats", () => {
    const key = phoneMatchKey("+15125550100");
    expect(key).toBe("5125550100");
    expect(phoneMatchKey("(512) 555-0100")).toBe(key);
    expect(phoneMatchKey("512.555.0100")).toBe(key);
    expect(phoneMatchKey("1-512-555-0100")).toBe(key);
  });

  it("returns null when there are no digits", () => {
    expect(phoneMatchKey("")).toBeNull();
    expect(phoneMatchKey(null)).toBeNull();
    expect(phoneMatchKey("Unknown")).toBeNull();
  });
});
