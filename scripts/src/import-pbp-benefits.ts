/**
 * Load the CMS "PBP Benefits" extract (plan benefits, costs and service areas)
 * into the cms_plan_* tables.
 *
 *   unzip pbp-benefits-2027.zip -d /path/to/pbp-2027
 *   DATABASE_URL=postgres://... pnpm --filter @workspace/scripts import:pbp \
 *     --dir /path/to/pbp-2027 [--year 2027] [--include-employer-groups]    # dry run
 *   ... same command plus --apply                                          # real load
 *
 * Safe by construction:
 *  - Dry run is the default: everything is read and inserted inside ONE
 *    transaction that is rolled back unless --apply is passed, so the report
 *    shows exactly what a real run would do.
 *  - It replaces the chosen plan year only (other years are untouched) and is
 *    safe to re-run: CMS refreshes this file quarterly.
 *  - Any error (missing file, wrong year, bad header) rolls everything back and
 *    leaves the previous data in place.
 *  - Contains public plan data only; no client data, no PHI.
 *
 * Employer/union group plans are left out unless --include-employer-groups is
 * passed (agents cannot sell them; they are ~85% of the service-area rows).
 */
import pg from "pg";
import { importPbpBenefits } from "@workspace/db/cmsPlans/pbpImport";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = arg("dir");
  const planYear = Number(arg("year") ?? "2027");
  if (!process.env.DATABASE_URL || !dir || !Number.isInteger(planYear)) {
    console.error(
      "Usage: DATABASE_URL=... import:pbp --dir <extracted PBP folder> [--year 2027] [--include-employer-groups] [--apply]",
    );
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    // Millions of rows in one transaction: lift the app's per-statement cap for this session only.
    await db.query("SET statement_timeout = 0");
    const report = await importPbpBenefits(db, {
      dir,
      planYear,
      includeEmployerGroups: process.argv.includes("--include-employer-groups"),
      dryRun: !apply,
      log: (line) => console.log(line),
    });
    console.log(
      `\n${apply ? "LOADED" : "DRY RUN (nothing saved; add --apply to save)"} — plan year ${planYear}`,
    );
    console.log(`plans: ${report.packages} (employer-group plans left out: ${report.employerGroupPlansExcluded})`);
    const unknown = report.files.filter((f) => f.skippedUnknownPlan > 0);
    for (const f of unknown) {
      console.log(`note: ${f.file} had ${f.skippedUnknownPlan} rows for plans missing from Section A (skipped)`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
