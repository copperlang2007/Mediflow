-- CMS Plan Benefit Package (PBP) reference data (public, plan-level, no PHI).
--
--   cms_plan_benefit_packages  one row per plan per year (the fields agents filter on)
--   cms_plan_benefit_sections  every CMS benefit column per plan, as JSON, one row per CMS file
--   cms_plan_service_areas     plan -> county (CMS/SSA 5-digit code, not FIPS) for local plans
--   cms_plan_regions           plan -> CMS region for regional plans / PDPs
--
-- Global tables: no org_id by design (same data for every agency). Loaded by
-- `pnpm --filter @workspace/scripts import:pbp`, which replaces a whole plan
-- year in one transaction; the ON DELETE CASCADE keys make that a single DELETE.
CREATE TABLE IF NOT EXISTS "cms_plan_benefit_packages" (
  "plan_year" integer NOT NULL,
  "bid_id" text NOT NULL,
  "contract_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "segment_id" text NOT NULL,
  "plan_type" text,
  "plan_type_label" text,
  "org_type" text,
  "org_name" text,
  "org_marketing_name" text,
  "plan_name" text,
  "org_website" text,
  "geography_name" text,
  "is_employer_group" boolean DEFAULT false NOT NULL,
  "is_snp" boolean DEFAULT false NOT NULL,
  "snp_type" text,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cms_plan_benefit_packages_pk" PRIMARY KEY ("plan_year", "bid_id")
);

CREATE INDEX IF NOT EXISTS "cms_plan_benefit_packages_contract_idx" ON "cms_plan_benefit_packages" USING btree ("plan_year", "contract_id");
CREATE INDEX IF NOT EXISTS "cms_plan_benefit_packages_type_idx" ON "cms_plan_benefit_packages" USING btree ("plan_year", "plan_type");

CREATE TABLE IF NOT EXISTS "cms_plan_benefit_sections" (
  "plan_year" integer NOT NULL,
  "bid_id" text NOT NULL,
  "section" text NOT NULL,
  "row_seq" integer DEFAULT 0 NOT NULL,
  "data" jsonb NOT NULL,
  CONSTRAINT "cms_plan_benefit_sections_pk" PRIMARY KEY ("plan_year", "bid_id", "section", "row_seq"),
  CONSTRAINT "cms_plan_benefit_sections_pkg_fk" FOREIGN KEY ("plan_year", "bid_id")
    REFERENCES "cms_plan_benefit_packages" ("plan_year", "bid_id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "cms_plan_service_areas" (
  "plan_year" integer NOT NULL,
  "bid_id" text NOT NULL,
  "county_code" text NOT NULL,
  "state_code" text,
  "county_name" text,
  "pending_flag" text,
  "partial_flag" text,
  CONSTRAINT "cms_plan_service_areas_pk" PRIMARY KEY ("plan_year", "bid_id", "county_code"),
  CONSTRAINT "cms_plan_service_areas_pkg_fk" FOREIGN KEY ("plan_year", "bid_id")
    REFERENCES "cms_plan_benefit_packages" ("plan_year", "bid_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "cms_plan_service_areas_county_idx" ON "cms_plan_service_areas" USING btree ("plan_year", "county_code");

CREATE TABLE IF NOT EXISTS "cms_plan_regions" (
  "plan_year" integer NOT NULL,
  "bid_id" text NOT NULL,
  "region_type" text NOT NULL,
  "region_code" text NOT NULL,
  "region_name" text,
  "pending_flag" text,
  "partial_flag" text,
  CONSTRAINT "cms_plan_regions_pk" PRIMARY KEY ("plan_year", "bid_id", "region_type", "region_code"),
  CONSTRAINT "cms_plan_regions_pkg_fk" FOREIGN KEY ("plan_year", "bid_id")
    REFERENCES "cms_plan_benefit_packages" ("plan_year", "bid_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "cms_plan_regions_region_idx" ON "cms_plan_regions" USING btree ("plan_year", "region_type", "region_code");
