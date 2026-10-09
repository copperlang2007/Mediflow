import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRecord, importPbpBenefits, sectionName } from "../pbpImport";

const MIGRATION = path.resolve(__dirname, "../../../migrations/0071_cms_plan_benefits.sql");

/** Tab-delimited, CRLF, Windows-1252 — exactly how CMS ships the files. */
function writeCms(dir: string, name: string, rows: string[][]): void {
  const text = rows.map((r) => r.join("\t")).join("\r\n") + "\r\n";
  writeFileSync(path.join(dir, name), Buffer.from(text, "latin1"));
}

const A_HEAD = [
  "pbp_a_hnumber", "pbp_a_plan_identifier", "segment_id", "pbp_a_ben_cov", "pbp_a_plan_type", "orgtype", "bid_id",
  "pbp_a_org_name", "pbp_a_plan_name", "pbp_a_plan_type", "pbp_a_eghp_yn", "pbp_a_special_need_flag",
  "pbp_a_special_need_plan_type", "pbp_a_plan_geog_name", "pbp_a_org_type", "pbp_a_ben_cov",
];
// "\x96" is a Windows-1252 en dash; plan_type is empty in its first column and set in the repeat.
const A_ROWS = [
  ["H1234", "001", "0", "", "", "1", "H1234_001_0", "Acme Health", "Acme Gold \x96 HMO", "01", "2", "1", "D-SNP", "Tarrant", "1", ""],
  ["H1234", "002", "0", "", "04", "1", "H1234_002_0", "Acme Health", "Acme PPO", "04", "2", "2", "", "Texas", "1", ""],
  ["H9999", "801", "0", "", "", "13", "H9999_801_0", "Union Fund", "Union Retiree Plan", "30", "1", "2", "", "National", "13", ""],
];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pbp-"));
  writeCms(dir, "pbp_Section_A.txt", [A_HEAD, ...A_ROWS]);
  writeCms(dir, "pbp_b16_dental.txt", [
    ["pbp_a_hnumber", "pbp_a_plan_identifier", "segment_id", "bid_id", "pbp_b16a_maxplan_amt", "pbp_b16a_notes"],
    ["H1234", "001", "0", "H1234_001_0", "1500", ""],
    ["H1234", "002", "0", "H1234_002_0", "", "Preventive only"],
    ["H9999", "801", "0", "H9999_801_0", "250", ""],
    ["H0000", "001", "0", "H0000_001_0", "9", ""],
  ]);
  writeCms(dir, "pbp_mrx_tier.txt", [
    ["pbp_a_hnumber", "bid_id", "mrx_tier_id", "mrx_tier_label"],
    ["H1234", "H1234_001_0", "1", "Preferred generic"],
    ["H1234", "H1234_001_0", "2", "Generic"],
  ]);
  writeCms(dir, "PlanArea.txt", [
    ["pbp_a_hnumber", "bid_id", "contract_id", "plan_id", "segment_id", "county_code", "pending_flag", "partial_flag", "contract_year", "eghp_flag", "county", "stcd"],
    ["H1234", "H1234_001_0", "H1234", "001", "0", "48439", "0", "", "2027", "0", "Tarrant", "TX"],
    ["H1234", "H1234_001_0", "H1234", "001", "0", "48439", "0", "", "2027", "0", "Tarrant", "TX"],
    ["H1234", "H1234_001_0", "H1234", "001", "0", "48113", "0", "*", "2027", "0", "Dallas", "TX"],
    ["H9999", "H9999_801_0", "H9999", "801", "0", "48439", "0", "", "2027", "1", "Tarrant", "TX"],
  ]);
  writeCms(dir, "PlanRegionArea.txt", [
    ["pbp_a_hnumber", "bid_id", "contract_year", "region_type", "ma_or_pdp_region_code", "region", "pending_flag", "partial_flag"],
    ["H1234", "H1234_002_0", "2027", "MA", "16", "Louisiana and Mississippi", "0", ""],
  ]);
  return dir;
}

describe("buildRecord / sectionName", () => {
  it("drops key columns and empties, and keeps the first non-empty duplicate", () => {
    expect(
      buildRecord(["bid_id", "a", "a", "b", "c"], ["H1_001_0", "", "x", "", "  y "]),
    ).toEqual({ a: "x", c: "y" });
  });
  it("names sections from file names", () => {
    expect(sectionName("pbp_b16_dental.txt")).toBe("b16_dental");
    expect(sectionName("pbp_Section_A.txt")).toBe("section_a");
  });
});

describe("importPbpBenefits", () => {
  let pg: PGlite;
  let dir: string;
  const count = async (t: string) =>
    Number((await pg.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n);

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(readFileSync(MIGRATION, "utf8"));
    dir = makeDir();
  });
  afterEach(async () => {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads individual-market plans and leaves employer-group plans out", async () => {
    const report = await importPbpBenefits(pg, { dir, planYear: 2027 });
    expect(report.packages).toBe(2);
    expect(report.employerGroupPlansExcluded).toBe(1);

    const pkgs = (await pg.query(
      "SELECT * FROM cms_plan_benefit_packages ORDER BY bid_id",
    )).rows as Record<string, unknown>[];
    expect(pkgs.map((p) => p.bid_id)).toEqual(["H1234_001_0", "H1234_002_0"]);
    expect(pkgs[0]).toMatchObject({
      plan_id: "001", // leading zeros survive
      plan_type: "01", // taken from the repeated column
      plan_type_label: "HMO",
      plan_name: "Acme Gold – HMO", // Windows-1252 en dash decoded
      is_snp: true,
      snp_type: "D-SNP",
      is_employer_group: false,
    });
  });

  it("stores every benefit column as JSON, one row per CMS row, skipping other plans", async () => {
    const report = await importPbpBenefits(pg, { dir, planYear: 2027 });
    const dental = report.files.find((f) => f.file === "pbp_b16_dental.txt")!;
    expect(dental).toMatchObject({ read: 4, inserted: 2, skippedEmployerGroup: 1, skippedUnknownPlan: 1 });

    const row = (await pg.query(
      "SELECT data FROM cms_plan_benefit_sections WHERE bid_id='H1234_001_0' AND section='b16_dental'",
    )).rows[0] as { data: Record<string, string> };
    expect(row.data).toEqual({ pbp_b16a_maxplan_amt: "1500" });

    const tiers = (await pg.query(
      "SELECT row_seq, data->>'mrx_tier_label' AS label FROM cms_plan_benefit_sections WHERE section='mrx_tier' ORDER BY row_seq",
    )).rows;
    expect(tiers).toEqual([{ row_seq: 0, label: "Preferred generic" }, { row_seq: 1, label: "Generic" }]);
  });

  it("loads counties (dropping verbatim repeats) and regions", async () => {
    const report = await importPbpBenefits(pg, { dir, planYear: 2027 });
    expect(await count("cms_plan_service_areas")).toBe(2);
    expect(report.files.find((f) => f.file === "PlanArea.txt")).toMatchObject({
      read: 4, inserted: 2, skippedEmployerGroup: 1,
    });
    const regions = (await pg.query("SELECT bid_id, region_type, region_code, region_name FROM cms_plan_regions")).rows;
    expect(regions).toEqual([
      { bid_id: "H1234_002_0", region_type: "MA", region_code: "16", region_name: "Louisiana and Mississippi" },
    ]);
  });

  it("includes employer-group plans only when asked", async () => {
    await importPbpBenefits(pg, { dir, planYear: 2027, includeEmployerGroups: true });
    expect(await count("cms_plan_benefit_packages")).toBe(3);
    expect(await count("cms_plan_service_areas")).toBe(3);
  });

  it("dry run writes nothing", async () => {
    const report = await importPbpBenefits(pg, { dir, planYear: 2027, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.packages).toBe(2);
    expect(await count("cms_plan_benefit_packages")).toBe(0);
    expect(await count("cms_plan_benefit_sections")).toBe(0);
  });

  it("re-running replaces the year instead of duplicating or failing", async () => {
    await importPbpBenefits(pg, { dir, planYear: 2027 });
    await importPbpBenefits(pg, { dir, planYear: 2027 });
    expect(await count("cms_plan_benefit_packages")).toBe(2);
    expect(await count("cms_plan_service_areas")).toBe(2);
  });

  it("does not touch another plan year", async () => {
    await pg.exec(`INSERT INTO cms_plan_benefit_packages (plan_year, bid_id, contract_id, plan_id, segment_id)
                   VALUES (2026, 'H1234_001_0', 'H1234', '001', '0')`);
    await importPbpBenefits(pg, { dir, planYear: 2027 });
    expect(await count("cms_plan_benefit_packages")).toBe(3);
  });

  it("rolls back everything, keeping the old data, when a file is for the wrong year", async () => {
    await importPbpBenefits(pg, { dir, planYear: 2027 });
    await expect(importPbpBenefits(pg, { dir, planYear: 2028 })).rejects.toThrow(/contract_year 2027/);
    expect(await count("cms_plan_benefit_packages")).toBe(2);
    await expect(
      importPbpBenefits(pg, { dir, planYear: 2027 }).then(() => count("cms_plan_service_areas")),
    ).resolves.toBe(2);
  });

  it.each(["PlanArea.txt", "PlanRegionArea.txt"])("refuses to run without %s", async (name) => {
    await importPbpBenefits(pg, { dir, planYear: 2027 });
    rmSync(path.join(dir, name));
    await expect(importPbpBenefits(pg, { dir, planYear: 2027 })).rejects.toThrow(/not found/);
    expect(await count("cms_plan_benefit_packages")).toBe(2); // good data kept
  });

  it("refuses header-only files before touching existing data", async () => {
    await importPbpBenefits(pg, { dir, planYear: 2027 });
    for (const name of ["pbp_Section_A.txt", "PlanArea.txt", "PlanRegionArea.txt"]) {
      const full = path.join(dir, name);
      const original = readFileSync(full);
      const headerOnly = original.toString("latin1").split("\r\n")[0] + "\r\n";
      writeFileSync(full, Buffer.from(headerOnly, "latin1"));
      await expect(importPbpBenefits(pg, { dir, planYear: 2027 })).rejects.toThrow(/no data rows/);
      writeFileSync(full, original);
    }
    expect(await count("cms_plan_benefit_packages")).toBe(2);
    expect(await count("cms_plan_service_areas")).toBe(2);
  });

  it("requires the employer-plan column so the default filter cannot silently turn off", async () => {
    writeCms(dir, "pbp_Section_A.txt", [
      A_HEAD.map((h) => (h === "pbp_a_eghp_yn" ? "renamed" : h)),
      ...A_ROWS,
    ]);
    await expect(importPbpBenefits(pg, { dir, planYear: 2027 })).rejects.toThrow(/pbp_a_eghp_yn/);
  });

  it("rejects a connection pool, which cannot keep one transaction", async () => {
    const fakePool = { totalCount: 0, query: pg.query.bind(pg) };
    await expect(importPbpBenefits(fakePool, { dir, planYear: 2027 })).rejects.toThrow(/single connection/);
  });

  it("fails clearly when Section A is missing", async () => {
    rmSync(path.join(dir, "pbp_Section_A.txt"));
    await expect(importPbpBenefits(pg, { dir, planYear: 2027 })).rejects.toThrow(/pbp_Section_A\.txt not found/);
  });
});
