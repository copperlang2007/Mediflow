/**
 * Unit tests for demo-mode gating (`lib/demoMode.ts`).
 *
 * The security-critical property: the auth bypass can NEVER activate under
 * NODE_ENV=production, regardless of the DEMO_MODE flag.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isDemoMode, demoUserId, DEFAULT_DEMO_USER_ID } from "../../lib/demoMode";

const ORIGINAL = {
  DEMO_MODE: process.env["DEMO_MODE"],
  NODE_ENV: process.env["NODE_ENV"],
  DEMO_USER_ID: process.env["DEMO_USER_ID"],
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isDemoMode", () => {
  it("is true when DEMO_MODE=true and NODE_ENV is not production", () => {
    process.env["DEMO_MODE"] = "true";
    process.env["NODE_ENV"] = "development";
    expect(isDemoMode()).toBe(true);
  });

  it("is FALSE under NODE_ENV=production even with DEMO_MODE=true", () => {
    process.env["DEMO_MODE"] = "true";
    process.env["NODE_ENV"] = "production";
    expect(isDemoMode()).toBe(false);
  });

  it("is false when DEMO_MODE is unset", () => {
    delete process.env["DEMO_MODE"];
    process.env["NODE_ENV"] = "development";
    expect(isDemoMode()).toBe(false);
  });

  it("is false for any DEMO_MODE value other than the exact string 'true'", () => {
    process.env["NODE_ENV"] = "development";
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      process.env["DEMO_MODE"] = value;
      expect(isDemoMode()).toBe(false);
    }
  });
});

describe("demoUserId", () => {
  it("defaults to the seeded INSUREitALL agency admin", () => {
    delete process.env["DEMO_USER_ID"];
    expect(demoUserId()).toBe(DEFAULT_DEMO_USER_ID);
  });

  it("honours a DEMO_USER_ID override", () => {
    process.env["DEMO_USER_ID"] = "00000000-0000-4000-8000-000000000012";
    expect(demoUserId()).toBe("00000000-0000-4000-8000-000000000012");
  });
});
