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
- Read path: `artifacts/api-server/src/routes/quotingPlans.ts` serves
  `GET /quoting/plan-areas/states`, `/quoting/plan-areas/counties?state=`,
  `/quoting/plans?state=&countyCode=&q=&snp=` and `/quoting/plans/:bidId`
  (latest plan year, employer groups hidden, `contact:read`). The Quoting page
  "Plan Comparison" tab uses them. Regional plans (PDP) and Medigap are not shown
  yet. The tables are listed in `GLOBAL_TABLES` in `tenant-isolation.test.ts`.

## Plan cards

Each plan in a county search comes back with a `card`, built by
`artifacts/api-server/src/lib/planCard.ts` from the plan's raw CMS rows; the
Quoting page shows it as a card (and a side-by-side compare of up to 4).

What a card shows, and the CMS columns it reads (checked against the CMS data
dictionary and against value distributions across all individual-market plans):

| Card field | CMS source |
| --- | --- |
| Monthly premium | `section_d.pbp_d_mplusc_premium` (health plan only) |
| Part B premium paid back | `pbp_d_mco_pay_reduct_yn` / `_amt` |
| Out-of-pocket max | `pbp_d_out_pocket_amt` (in-network), `pbp_d_comb_max_enr_amt` (combined, PPOs) |
| Medical deductible | `pbp_d_ann_deduct_yn` / `_amt` (shown only when CMS answers; a blank answer is not claimed as $0) |
| Primary care, specialist | `b7_health_prof` `pbp_b7a_*`, `pbp_b7d_*` |
| ER, urgent care | `b4_emerg_urgent` `pbp_b4a_*`, `pbp_b4b_*` |
| Hospital stay | `b1a_inpat_hosp` `pbp_b1a_copay_mcs_*` ("Copayment for Medicare-covered stay", day ranges) |
| Dental, vision, hearing, OTC, fitness, meals, rides | `b16`, `b17`, `b18`, `b13`, `b14`, `b10_amb_trans` (included only when the benefit type is mandatory/both, never optional) |
| Drug coverage and deductible | `mrx.mrx_drug_ben_yn`, `mrx_alt_ded_charge` / `_amount` |

Rules the decoder follows: a service with copay "no" and coinsurance "no" has no
cost share ($0); a "yes" with no readable amount stays unknown; tiered hospital
structures are left out of the card; unknown shows "See details", never a guess.

**Not in the CMS plan benefit file, so never shown on a card:** the Part D (drug
plan) premium, star ratings, provider networks, drug lists (formularies) and
Medigap. The premium on a card is the health plan premium only, and cards for
plans with drug coverage say so. A dual-eligible (D-SNP) card also notes that
Medicaid may cover the cost-sharing shown. Adding the drug premium and star
ratings needs the CMS Landscape / Star Ratings files.

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
