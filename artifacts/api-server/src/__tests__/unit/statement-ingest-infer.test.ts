import { describe, it, expect } from "vitest";
import {
  inferCarrier,
  inferPeriod,
  inferStatementDate,
  isSupportedStatementFile,
  monthFromFilename,
} from "../../lib/statementIngest/infer";
import type { NormalizedLineItem } from "../../lib/commissionParsers";

const carriers = [
  { id: "c-hum", name: "Humana", isActive: true },
  { id: "c-uhc", name: "UnitedHealthcare", isActive: true },
  { id: "c-aet", name: "Aetna Medicare", isActive: false },
];

function line(periodStart: string | null, periodEnd: string | null): NormalizedLineItem {
  return {
    memberId: null, policyNumber: null, planType: null, planYear: null,
    periodStart, periodEnd, premium: null, commissionAmount: "1.00", type: "initial",
    contactFirstName: null, contactLastName: null, contactDob: null, contactStateCode: null, raw: {},
  };
}

describe("inferCarrier", () => {
  it("resolves from the folder name", () => {
    const r = inferCarrier(carriers, { folderName: "Humana Statements", fileName: "x.csv" });
    expect(r).toMatchObject({ ok: true, via: "folder", carrier: { id: "c-hum" } });
  });

  it("falls back to the filename, using the same family rules as the parsers", () => {
    const r = inferCarrier(carriers, { folderName: null, fileName: "UHC_commission_2026-09.csv" });
    expect(r).toMatchObject({ ok: true, via: "filename", carrier: { id: "c-uhc" } });
  });

  it("an explicit mapping wins over name matching", () => {
    const r = inferCarrier(carriers, { folderName: "Statements Q3", fileName: "x.csv" }, { "statements q3": "c-uhc" });
    expect(r).toMatchObject({ ok: true, via: "mapping", carrier: { id: "c-uhc" } });
  });

  it("refuses when the mapped carrier no longer exists", () => {
    const r = inferCarrier(carriers, { folderName: "Misc", fileName: "x.csv" }, { Misc: "gone" });
    expect(r.ok).toBe(false);
  });

  it("ignores inactive carriers", () => {
    const r = inferCarrier(carriers, { folderName: "Aetna", fileName: "x.csv" });
    expect(r.ok).toBe(false);
  });

  it("refuses an ambiguous match instead of guessing", () => {
    const two = [...carriers, { id: "c-hum2", name: "Humana East", isActive: true }];
    const r = inferCarrier(two, { folderName: "Humana", fileName: "x.csv" });
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses when nothing identifies the carrier", () => {
    expect(inferCarrier(carriers, { folderName: "Inbox", fileName: "statement.csv" }).ok).toBe(false);
  });
});

describe("monthFromFilename", () => {
  it.each([
    ["Humana_2026-09.csv", 2026, 9],
    ["humana 202609.csv", 2026, 9],
    ["Humana_09-2026.csv", 2026, 9],
    ["Humana September 2026.csv", 2026, 9],
    ["UHC_Sep2026_commissions.csv", 2026, 9],
    ["statement_2026-09-30.csv", 2026, 9],
  ])("%s", (name, year, month) => {
    expect(monthFromFilename(name)).toEqual({ year, month });
  });

  it("returns null when there is no month, including an invalid one", () => {
    expect(monthFromFilename("statement.csv")).toBeNull();
    expect(monthFromFilename("report_2026-13.csv")).toBeNull();
    expect(monthFromFilename("file_123456.csv")).toBeNull();
  });
});

describe("inferPeriod", () => {
  it("uses the whole calendar month from the filename, including leap February", () => {
    expect(inferPeriod("x_2028-02.csv", [])).toEqual({
      periodStart: "2028-02-01", periodEnd: "2028-02-29", source: "filename",
    });
  });

  it("falls back to the most common line period, tolerating a back-dated chargeback", () => {
    const lines = [
      line("2026-09-01", "2026-09-30"),
      line("2026-09-01", "2026-09-30"),
      line("2026-07-01", "2026-07-31"),
    ];
    expect(inferPeriod("statement.csv", lines)).toEqual({
      periodStart: "2026-09-01", periodEnd: "2026-09-30", source: "lines",
    });
  });

  it("returns null when neither the name nor the lines say", () => {
    expect(inferPeriod("statement.csv", [line(null, null)])).toBeNull();
  });
});

describe("inferStatementDate", () => {
  const period = { periodStart: "2026-09-01", periodEnd: "2026-09-30", source: "filename" as const };
  it("prefers a full date in the filename", () => {
    expect(inferStatementDate("s_2026-10-02.csv", new Date("2026-10-05T00:00:00Z"), period)).toBe("2026-10-02");
  });
  it("then the file's modified date", () => {
    expect(inferStatementDate("s.csv", new Date("2026-10-05T12:00:00Z"), period)).toBe("2026-10-05");
  });
  it("then the period end", () => {
    expect(inferStatementDate("s.csv", null, period)).toBe("2026-09-30");
  });
});

describe("isSupportedStatementFile", () => {
  it("accepts delimited text and rejects PDFs and spreadsheets", () => {
    expect(isSupportedStatementFile("a.CSV")).toBe(true);
    expect(isSupportedStatementFile("a.txt")).toBe(true);
    expect(isSupportedStatementFile("a.pdf")).toBe(false);
    expect(isSupportedStatementFile("a.xlsx")).toBe(false);
    expect(isSupportedStatementFile("noext")).toBe(false);
  });
});
