/**
 * Unit tests for the shared definitions introduced by the QA data pass:
 * license active/expired, statement display status, report date ranges.
 */
import { describe, it, expect, vi } from "vitest";

// Pure helpers only — no database. The modules import table objects from
// @workspace/db, whose index would demand DATABASE_URL.
vi.mock("@workspace/db", async () => ({ ...(await import("@workspace/db/schema")), db: {} }));
import type { Request } from "express";
import {
  effectiveLicenseStatus,
  isLicenseActive,
  isLicenseExpired,
} from "../licenses/licenseStatus";
import {
  displayStatementStatus,
  statementVariance,
} from "../commissions/statementStatus";
import { parseRange } from "../../routes/reports/shared";

const NOW = new Date("2026-09-27T12:00:00Z");
const past = "2026-01-15T00:00:00Z";
const future = "2027-01-15T00:00:00Z";

describe("license definition", () => {
  it("active needs status active AND an expiry in the future (or none)", () => {
    expect(isLicenseActive({ status: "active", expiryDate: future }, NOW)).toBe(true);
    expect(isLicenseActive({ status: "active", expiryDate: null }, NOW)).toBe(true);
    expect(isLicenseActive({ status: "active", expiryDate: past }, NOW)).toBe(false);
    expect(isLicenseActive({ status: "pending", expiryDate: future }, NOW)).toBe(false);
  });

  it("expired = past expiry regardless of stored status, or stored expired", () => {
    expect(isLicenseExpired({ status: "active", expiryDate: past }, NOW)).toBe(true);
    expect(isLicenseExpired({ status: "suspended", expiryDate: past }, NOW)).toBe(true);
    expect(isLicenseExpired({ status: "expired", expiryDate: future }, NOW)).toBe(true);
    expect(isLicenseExpired({ status: "active", expiryDate: future }, NOW)).toBe(false);
  });

  it("the expiry instant itself counts as expired (matches readiness' expiry > now)", () => {
    expect(isLicenseExpired({ status: "active", expiryDate: NOW }, NOW)).toBe(true);
  });

  it("effectiveStatus only overrides to 'expired'", () => {
    expect(effectiveLicenseStatus({ status: "active", expiryDate: past }, NOW)).toBe("expired");
    expect(effectiveLicenseStatus({ status: "pending", expiryDate: future }, NOW)).toBe("pending");
    expect(effectiveLicenseStatus({ status: "not_appointed", expiryDate: null }, NOW)).toBe("not_appointed");
  });
});

describe("statement display status", () => {
  it("computes variance only when there is something to compare", () => {
    expect(statementVariance("1875.50", 2450, 4)).toBe(-574.5);
    expect(statementVariance(null, 2450, 4)).toBeNull();
    expect(statementVariance("100.00", 0, 0)).toBeNull();
  });

  it("never shows a variance statement as plain 'reconciled'", () => {
    expect(displayStatementStatus("reconciled", -574.5)).toBe("reconciled_with_variance");
    expect(displayStatementStatus("reconciled", 0.004)).toBe("reconciled");
    expect(displayStatementStatus("reconciled", 0)).toBe("reconciled");
    expect(displayStatementStatus("reconciled", null)).toBe("reconciled");
    expect(displayStatementStatus("parsed", -10)).toBe("parsed");
  });
});

describe("report date range", () => {
  const req = (q: Record<string, string>) => ({ query: q }) as unknown as Request;

  it("treats a date-only endDate as the END of that day (inclusive)", () => {
    const { end } = parseRange(req({ startDate: "2026-09-01", endDate: "2026-09-27" }));
    expect(end.toISOString()).toBe("2026-09-27T23:59:59.999Z");
  });

  it("uses a full timestamp as given", () => {
    const { end } = parseRange(req({ endDate: "2026-09-27T10:00:00.000Z" }));
    expect(end.toISOString()).toBe("2026-09-27T10:00:00.000Z");
  });
});
