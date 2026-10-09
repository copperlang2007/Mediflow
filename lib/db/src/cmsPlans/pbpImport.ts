/**
 * Loader for the CMS "PBP Benefits" extract (tab-delimited .txt files) into the
 * `cms_plan_*` tables. Used by `scripts/src/import-pbp-benefits.ts`; kept here,
 * behind a tiny `Queryable` interface, so tests can drive it with PGlite.
 *
 * Behavior:
 *  - Replaces one plan year atomically: DELETE the year's packages (children
 *    cascade), insert everything, COMMIT. `dryRun` does the same and ROLLBACKs.
 *  - Individual-market only by default. Employer/union group plans (CMS flag
 *    `pbp_a_eghp_yn = 1`) are ~21% of plans but ~85% of service-area rows and
 *    cannot be sold by agents; `includeEmployerGroups` loads them too.
 *  - Files are Windows-1252, not UTF-8 (dashes/accents in plan names).
 *  - Values stay CMS text; empty values are dropped from the JSON.
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Anything with pg's `query(text, values)`; both `pg.Client` and PGlite fit. */
export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;
}

export interface ImportOptions {
  dir: string;
  planYear: number;
  includeEmployerGroups?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface FileReport {
  file: string;
  read: number;
  inserted: number;
  /** Rows for plans left out by the employer-group filter. */
  skippedEmployerGroup: number;
  /** Rows whose bid_id is not in Section A at all. */
  skippedUnknownPlan: number;
}

export interface ImportReport {
  planYear: number;
  dryRun: boolean;
  packages: number;
  employerGroupPlansExcluded: number;
  files: FileReport[];
}

/** From the CMS PBP 2027 data dictionary (pbp_Section_A / pbp_a_plan_type). */
export const PLAN_TYPE_LABELS: Record<string, string> = {
  "01": "HMO",
  "02": "HMOPOS",
  "04": "Local PPO",
  "05": "PSO (State License)",
  "07": "MSA",
  "08": "RFB PFFS",
  "09": "PFFS",
  "18": "1876 Cost",
  "19": "HCPP - 1833 Cost",
  "20": "National Pace",
  "29": "Medicare Prescription Drug Plan",
  "30": "Employer/Union Only Direct Contract PDP",
  "31": "Regional PPO",
  "32": "Fallback",
  "40": "Employer/Union Only Direct Contract PFFS",
  "42": "RFB HMO",
  "43": "RFB HMOPOS",
  "44": "RFB Local PPO",
  "45": "RFB PSO (State License)",
  "47": "Employer Direct PPO",
};

/** Columns already stored on the package row (or pure keys); not repeated in JSON. */
const KEY_COLUMNS = new Set(["pbp_a_hnumber", "pbp_a_plan_identifier", "segment_id", "bid_id"]);

export async function* readLines(file: string): AsyncGenerator<string> {
  const decoder = new TextDecoder("windows-1252");
  let carry = "";
  for await (const chunk of createReadStream(file)) {
    carry += decoder.decode(chunk as Buffer, { stream: true });
    let nl: number;
    let from = 0;
    while ((nl = carry.indexOf("\n", from)) >= 0) {
      let line = carry.slice(from, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      from = nl + 1;
      yield line;
    }
    carry = carry.slice(from);
  }
  carry += decoder.decode();
  if (carry.length > 0) yield carry.endsWith("\r") ? carry.slice(0, -1) : carry;
}

/** First index of each (lower-cased) header name, plus every index for repeats. */
export function indexHeader(header: string[]): { names: string[]; first: Map<string, number> } {
  const names = header.map((h) => h.trim().toLowerCase());
  const first = new Map<string, number>();
  names.forEach((n, i) => {
    if (!first.has(n)) first.set(n, i);
  });
  return { names, first };
}

/**
 * Header -> JSON object. A column that appears twice (Section A repeats
 * `pbp_a_plan_type` and `pbp_a_ben_cov`) keeps its first non-empty value.
 */
export function buildRecord(names: string[], cells: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (KEY_COLUMNS.has(name) || name in out) continue;
    const v = cells[i]?.trim();
    if (v) out[name] = v;
  }
  return out;
}

/** "pbp_B16_Dental.txt" -> "b16_dental"; "pbp_Section_A.txt" -> "section_a". */
export function sectionName(fileName: string): string {
  return fileName.replace(/\.txt$/i, "").replace(/^pbp_/i, "").toLowerCase();
}

const BATCH_ROWS = 400;

/** Inserts one batch and returns how many rows were actually written. */
async function insertBatch(
  db: Queryable,
  table: string,
  columns: string[],
  rows: unknown[][],
  opts: { casts?: Record<string, string>; ignoreDuplicates?: boolean } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const ph = row.map((v, c) => {
      values.push(v);
      const cast = opts.casts?.[columns[c]!];
      return `$${values.length}${cast ? `::${cast}` : ""}`;
    });
    return `(${ph.join(",")})`;
  });
  const res = await db.query(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}` +
      (opts.ignoreDuplicates ? " ON CONFLICT DO NOTHING" : ""),
    values,
  );
  return res.rowCount ?? res.affectedRows ?? rows.length;
}

/** Streams a tab-delimited file as header + rows of cells. */
async function* readTable(
  file: string,
): AsyncGenerator<{ names: string[]; first: Map<string, number>; cells: string[] }> {
  let head: ReturnType<typeof indexHeader> | null = null;
  for await (const line of readLines(file)) {
    if (line === "") continue;
    const cells = line.split("\t");
    if (!head) {
      head = indexHeader(cells);
      continue;
    }
    yield { ...head, cells };
  }
  if (!head) throw new Error(`${path.basename(file)} is empty (no header row)`);
}

function need(first: Map<string, number>, file: string, ...cols: string[]): void {
  const missing = cols.filter((c) => !first.has(c));
  if (missing.length > 0) {
    throw new Error(`${file}: missing expected column(s) ${missing.join(", ")}`);
  }
}

function cell(row: { first: Map<string, number>; cells: string[] }, name: string): string {
  const i = row.first.get(name);
  return i === undefined ? "" : (row.cells[i] ?? "").trim();
}

/** Case-insensitive lookup of a file in `dir`. */
async function findFile(dir: string, wanted: string): Promise<string | null> {
  const hit = (await readdir(dir)).find((f) => f.toLowerCase() === wanted.toLowerCase());
  return hit ? path.join(dir, hit) : null;
}

export async function importPbpBenefits(db: Queryable, opts: ImportOptions): Promise<ImportReport> {
  const log = opts.log ?? (() => {});
  const { planYear, dir } = opts;

  const sectionAPath = await findFile(dir, "pbp_Section_A.txt");
  if (!sectionAPath) throw new Error(`pbp_Section_A.txt not found in ${dir}`);

  // Section A carries no year. The service-area files do (contract_year), so at
  // least one must be present for --year to be checked against the extract.
  if (!(await findFile(dir, "PlanArea.txt")) && !(await findFile(dir, "PlanRegionArea.txt"))) {
    throw new Error(
      `neither PlanArea.txt nor PlanRegionArea.txt found in ${dir}; cannot check --year against the extract`,
    );
  }

  const sectionFiles = (await readdir(dir))
    .filter((f) => /^pbp_.+\.txt$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  await db.query("BEGIN");
  try {
    const lock = await db.query("SELECT pg_try_advisory_xact_lock(hashtext('cms_plan_import')) AS ok");
    if (lock.rows[0]?.ok !== true) throw new Error("another PBP import is already running");

    await db.query("DELETE FROM cms_plan_benefit_packages WHERE plan_year = $1", [planYear]);

    // ---- Section A: the plan list (decides which plans every other file keeps)
    const included = new Set<string>();
    const excluded = new Set<string>();
    const pkgCols = [
      "plan_year", "bid_id", "contract_id", "plan_id", "segment_id", "plan_type", "plan_type_label",
      "org_type", "org_name", "org_marketing_name", "plan_name", "org_website", "geography_name",
      "is_employer_group", "is_snp", "snp_type",
    ];
    let pending: unknown[][] = [];
    for await (const row of readTable(sectionAPath)) {
      need(row.first, "pbp_Section_A.txt", "bid_id", "pbp_a_hnumber", "pbp_a_plan_identifier", "segment_id");
      const bidId = cell(row, "bid_id");
      if (!bidId) continue;
      const employer = cell(row, "pbp_a_eghp_yn") === "1";
      if (employer && !opts.includeEmployerGroups) {
        excluded.add(bidId);
        continue;
      }
      included.add(bidId);
      const planType = record1(row, "pbp_a_plan_type");
      pending.push([
        planYear, bidId, cell(row, "pbp_a_hnumber"), cell(row, "pbp_a_plan_identifier"),
        cell(row, "segment_id"), planType || null, PLAN_TYPE_LABELS[planType] ?? null,
        cell(row, "pbp_a_org_type") || cell(row, "orgtype") || null,
        cell(row, "pbp_a_org_name") || null, cell(row, "pbp_a_org_marketing_name") || null,
        cell(row, "pbp_a_plan_name") || null, cell(row, "pbp_a_org_website") || null,
        cell(row, "pbp_a_plan_geog_name") || null, employer,
        cell(row, "pbp_a_special_need_flag") === "1",
        cell(row, "pbp_a_special_need_plan_type") || null,
      ]);
      if (pending.length >= BATCH_ROWS) {
        await insertBatch(db, "cms_plan_benefit_packages", pkgCols, pending);
        pending = [];
      }
    }
    await insertBatch(db, "cms_plan_benefit_packages", pkgCols, pending);
    log(`packages: ${included.size} loaded, ${excluded.size} employer-group plans left out`);

    const files: FileReport[] = [];

    // ---- Benefit sections (Section A included, so its extra columns are kept as JSON too)
    for (const file of sectionFiles) {
      const report: FileReport = { file, read: 0, inserted: 0, skippedEmployerGroup: 0, skippedUnknownPlan: 0 };
      const section = sectionName(file);
      const seq = new Map<string, number>();
      let batch: unknown[][] = [];
      for await (const row of readTable(path.join(dir, file))) {
        need(row.first, file, "bid_id");
        report.read++;
        const bidId = cell(row, "bid_id");
        if (!included.has(bidId)) {
          if (excluded.has(bidId)) report.skippedEmployerGroup++;
          else report.skippedUnknownPlan++;
          continue;
        }
        const rowSeq = seq.get(bidId) ?? 0;
        seq.set(bidId, rowSeq + 1);
        batch.push([planYear, bidId, section, rowSeq, JSON.stringify(buildRecord(row.names, row.cells))]);
        report.inserted++;
        if (batch.length >= BATCH_ROWS) {
          await insertBatch(db, "cms_plan_benefit_sections",
            ["plan_year", "bid_id", "section", "row_seq", "data"], batch, { casts: { data: "jsonb" } });
          batch = [];
        }
      }
      await insertBatch(db, "cms_plan_benefit_sections",
        ["plan_year", "bid_id", "section", "row_seq", "data"], batch, { casts: { data: "jsonb" } });
      files.push(report);
      log(`${file}: ${report.inserted}/${report.read} rows`);
    }

    // ---- Service areas: counties (local plans) and regions (regional plans, PDPs)
    const areaFile = await findFile(dir, "PlanArea.txt");
    if (areaFile) {
      const cols = ["plan_year", "bid_id", "county_code", "state_code", "county_name", "pending_flag", "partial_flag"];
      files.push(await loadAreas(db, areaFile, "PlanArea.txt", included, excluded, "cms_plan_service_areas", cols,
        planYear, (row) => [
          cell(row, "county_code"), cell(row, "stcd") || null, cell(row, "county") || null,
          cell(row, "pending_flag") || null, cell(row, "partial_flag") || null,
        ], ["county_code"], log));
    }
    const regionFile = await findFile(dir, "PlanRegionArea.txt");
    if (regionFile) {
      const cols = ["plan_year", "bid_id", "region_type", "region_code", "region_name", "pending_flag", "partial_flag"];
      files.push(await loadAreas(db, regionFile, "PlanRegionArea.txt", included, excluded, "cms_plan_regions", cols,
        planYear, (row) => [
          cell(row, "region_type"), cell(row, "ma_or_pdp_region_code"), cell(row, "region") || null,
          cell(row, "pending_flag") || null, cell(row, "partial_flag") || null,
        ], ["region_type", "ma_or_pdp_region_code"], log));
    }

    await db.query(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return {
      planYear,
      dryRun: Boolean(opts.dryRun),
      packages: included.size,
      employerGroupPlansExcluded: excluded.size,
      files,
    };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** First non-empty value of a column that may appear twice in the header. */
function record1(row: { names: string[]; cells: string[] }, name: string): string {
  for (let i = 0; i < row.names.length; i++) {
    if (row.names[i] === name) {
      const v = (row.cells[i] ?? "").trim();
      if (v) return v;
    }
  }
  return "";
}

async function loadAreas(
  db: Queryable,
  file: string,
  label: string,
  included: Set<string>,
  excluded: Set<string>,
  table: string,
  columns: string[],
  planYear: number,
  extra: (row: { first: Map<string, number>; cells: string[] }) => unknown[],
  required: string[],
  log: (line: string) => void,
): Promise<FileReport> {
  const report: FileReport = { file: label, read: 0, inserted: 0, skippedEmployerGroup: 0, skippedUnknownPlan: 0 };
  let batch: unknown[][] = [];
  const flush = async () => {
    // CMS repeats a few (plan, county) rows verbatim; keep the first.
    report.inserted += await insertBatch(db, table, columns, batch, { ignoreDuplicates: true });
    batch = [];
  };
  for await (const row of readTable(file)) {
    need(row.first, label, "bid_id", "contract_year", ...required);
    report.read++;
    const year = Number(cell(row, "contract_year"));
    if (year !== planYear) {
      throw new Error(`${label}: contract_year ${year} does not match --year ${planYear}`);
    }
    const bidId = cell(row, "bid_id");
    if (!included.has(bidId)) {
      if (excluded.has(bidId)) report.skippedEmployerGroup++;
      else report.skippedUnknownPlan++;
      continue;
    }
    batch.push([planYear, bidId, ...extra(row)]);
    if (batch.length >= 4000) await flush();
  }
  await flush();
  log(`${label}: ${report.inserted}/${report.read} rows`);
  return report;
}
