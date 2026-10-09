# CMS plan benefit data (PBP)

Public plan data that CMS publishes every year for all Medicare Advantage and
Part D plans: who offers each plan, what it costs, what it covers, and where it
is sold. No client data, no PHI. It is the same for every agency, so these
tables have no `org_id` (global tables, like the shared Knowledge Base).

## Tables (migration `0071_cms_plan_benefits`)

| Table | One row per | Use |
| --- | --- | --- |
| `cms_plan_benefit_packages` | plan per year | Filter and list plans: carrier, plan name, plan type, SNP, contract/plan/segment |
| `cms_plan_benefit_sections` | plan per CMS file (several for a few files) | Every CMS benefit column, as JSON. `section` is the CMS file name without `pbp_`/`.txt` (`section_d` premiums and out-of-pocket limits, `b16_dental`, `mrx_tier` drug tiers, ...) |
| `cms_plan_service_areas` | plan per county | "Which plans are sold in this county?" |
| `cms_plan_regions` | plan per region | Regional PPOs and PDPs, which serve regions instead of counties |

Things a reader must know:

- Values are CMS text exactly as published. `"1"`/`"2"` are yes/no, plan ids keep
  leading zeros (`"001"`). Decode with `PBP_Benefits_2027_dictionary.xlsx` from
  the CMS zip (the `JSON QUESTION`, `CODES` and `CODE_VALUES` columns).
- `county_code` is the CMS/SSA county code, **not FIPS** (Tarrant, TX is `45910`;
  its FIPS is `48439`). Matching a client's county needs an SSA-to-FIPS crosswalk.
- Individual-market plans only by default. Employer-only plans (800-series,
  1,673 of 7,973 for 2027) are skipped; they cannot be sold by agents and make up
  about 85% of the service-area rows. Pass `--include-employer-groups` to load them.
- Nothing in the app reads these tables yet (no API route or screen). When one
  does, add its table to `GLOBAL_TABLES` in `tenant-isolation.test.ts`.

## Loading a new extract (yearly, and each CMS quarterly refresh)

The CMS zip holds tab-delimited `.txt` files (Windows-1252), SAS readers and the
dictionary. They are not committed (the 2027 extract is 252 MB unzipped).

```bash
unzip pbp-benefits-2027.zip -d /path/to/pbp-2027
export DATABASE_URL=postgres://...            # the target database
pnpm --filter @workspace/db run migrate       # once, creates the tables
pnpm --filter @workspace/scripts import:pbp --dir /path/to/pbp-2027            # dry run
pnpm --filter @workspace/scripts import:pbp --dir /path/to/pbp-2027 --apply    # real load
```

The dry run reads everything and rolls back, so its counts are what a real run
will write. A real run replaces that plan year in one transaction (other years
are untouched); any error leaves the previous data in place. Re-running is safe.

2027 extract result (verified on PostgreSQL 16): 6,300 plans, 377,453 section
rows, 125,383 county rows, 364 region rows, about 320 MB of database. The run
takes under a minute.

Before the first production load, run the dry run (no `--apply`) against the
production database from a trusted machine and watch database CPU, storage and
WAL in the Cloud SQL console; it has only been exercised on a local PostgreSQL 16. The whole
load is one transaction (about 320 MB of data, plus the same again being
replaced on a re-run), so make sure the instance has that much free disk.

To use a different year, pass `--year`; the importer refuses files whose
`contract_year` does not match.
