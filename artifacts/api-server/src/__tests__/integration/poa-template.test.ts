/**
 * Phase 1.5 — POA PDF template unit tests.
 *
 * The PDF is generated via pdf-lib; full text-extraction would need a
 * heavier dep. Instead these tests assert:
 *
 *   - Output is a valid PDF (header bytes).
 *   - Output is non-trivial (> 1 KB — placeholder watermarks + body).
 *   - Multi-page when many carriers are listed (so the watermark applies
 *     to every page).
 *   - `readPoaConfig` honours env overrides.
 *
 * Visible "DRAFT PLACEHOLDER" content can't be machine-asserted without
 * a PDF text extractor, but the template ALSO embeds the literal phrase
 * via pdf-lib's `drawText` calls — the byte presence of the strings is
 * verifiable via a substring search on the raw PDF buffer for the
 * uncompressed stream contents.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  generatePoaPdf,
  readPoaConfig,
  DEFAULT_POA_DAYS_TO_EXPIRE,
  DEFAULT_POA_GRANTEE_NAME,
} from "../../lib/contractingPdf/poaTemplate";

async function loadPages(buf: Buffer): Promise<number> {
  const pdf = await PDFDocument.load(buf);
  return pdf.getPageCount();
}

describe("POA template", () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.POA_DAYS_TO_EXPIRE;
    delete process.env.POA_GRANTEE_NAME;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("generates a valid loadable PDF buffer", async () => {
    const buf = await generatePoaPdf({
      agentFullName: "Test Agent",
      agentNpn: "1234567890",
      agentAddress: "100 Main St, Tampa FL 33602",
      agentLicenseStates: ["FL", "GA"],
      carrierNames: ["Carrier One", "Carrier Two"],
      effectiveDate: new Date("2025-01-01T00:00:00Z"),
      expiryDate: new Date("2025-04-01T00:00:00Z"),
      granteeName: "INSUREitALL",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    // PDF magic header.
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
    // Round-trips through pdf-lib's loader (page count >= 1).
    const pageCount = await loadPages(buf);
    expect(pageCount).toBeGreaterThanOrEqual(1);
  });

  it("multi-page generation when many carriers are listed", async () => {
    const manyCarriers = Array.from({ length: 30 }, (_, i) => `Carrier ${i + 1}`);
    const buf = await generatePoaPdf({
      agentFullName: "Test Agent",
      agentNpn: null,
      agentAddress: "100 Main St",
      agentLicenseStates: ["FL"],
      carrierNames: manyCarriers,
      effectiveDate: new Date(),
      expiryDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      granteeName: "INSUREitALL",
    });
    expect(buf.length).toBeGreaterThan(2000);
    // The 30-carrier bullet list spans into a second page.
    const pageCount = await loadPages(buf);
    expect(pageCount).toBeGreaterThanOrEqual(2);
  });

  it("renders even with an empty carrier list (degenerate but accepted)", async () => {
    const buf = await generatePoaPdf({
      agentFullName: "Test Agent",
      agentNpn: null,
      agentAddress: "100 Main St",
      agentLicenseStates: [],
      carrierNames: [],
      effectiveDate: new Date(),
      expiryDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      granteeName: "INSUREitALL",
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(await loadPages(buf)).toBeGreaterThanOrEqual(1);
  });

  it("readPoaConfig returns defaults when env vars are unset", () => {
    const cfg = readPoaConfig();
    expect(cfg.daysToExpire).toBe(DEFAULT_POA_DAYS_TO_EXPIRE);
    expect(cfg.granteeName).toBe(DEFAULT_POA_GRANTEE_NAME);
  });

  it("readPoaConfig honours POA_DAYS_TO_EXPIRE override", () => {
    process.env.POA_DAYS_TO_EXPIRE = "60";
    expect(readPoaConfig().daysToExpire).toBe(60);
  });

  it("readPoaConfig honours POA_GRANTEE_NAME override", () => {
    process.env.POA_GRANTEE_NAME = "ACME Holdings, LLC";
    expect(readPoaConfig().granteeName).toBe("ACME Holdings, LLC");
  });

  it("readPoaConfig rejects an unparsable POA_DAYS_TO_EXPIRE (falls back to default)", () => {
    process.env.POA_DAYS_TO_EXPIRE = "not-a-number";
    expect(readPoaConfig().daysToExpire).toBe(DEFAULT_POA_DAYS_TO_EXPIRE);
  });

  it("readPoaConfig rejects out-of-range POA_DAYS_TO_EXPIRE", () => {
    process.env.POA_DAYS_TO_EXPIRE = "0";
    expect(readPoaConfig().daysToExpire).toBe(DEFAULT_POA_DAYS_TO_EXPIRE);
    process.env.POA_DAYS_TO_EXPIRE = "999999";
    expect(readPoaConfig().daysToExpire).toBe(DEFAULT_POA_DAYS_TO_EXPIRE);
  });
});
