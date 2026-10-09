/**
 * CMS Plan Benefit Package (PBP) reference data.
 *
 * Public, plan-level data that CMS publishes each year for every Medicare
 * Advantage and Part D plan: who offers it, what it costs, what it covers and
 * which counties it serves. It is loaded by
 * `pnpm --filter @workspace/scripts import:pbp` from the "PBP Benefits" zip.
 *
 * Global by design: there is no `org_id` (the data is the same for every
 * agency, contains no client data and no PHI). Only the importer writes to it;
 * agencies would read it. If a route reads these tables it must be listed in
 * GLOBAL_TABLES in `tenant-isolation.test.ts`.
 *
 * Shape: one typed row per plan (`cms_plan_benefit_packages`) for the fields an
 * agent filters on, plus every other CMS column kept losslessly as JSON in
 * `cms_plan_benefit_sections` (one row per plan per CMS file; a few files have
 * several rows per plan, ordered by `row_seq`). Values stay as CMS text
 * (leading zeros, "1"/"2" yes/no codes) — decode with the CMS data dictionary.
 */
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const cmsPlanBenefitPackagesTable = pgTable(
  "cms_plan_benefit_packages",
  {
    planYear: integer("plan_year").notNull(),
    /** CMS bid id: contract_plan_segment, e.g. "H1234_001_0". */
    bidId: text("bid_id").notNull(),
    /** CMS contract number ("H" number), e.g. "H1234". */
    contractId: text("contract_id").notNull(),
    /** Three-character plan id, leading zeros kept, e.g. "001". */
    planId: text("plan_id").notNull(),
    segmentId: text("segment_id").notNull(),
    /** CMS plan type code ("01" HMO, "04" Local PPO, "29" PDP, ...). */
    planType: text("plan_type"),
    planTypeLabel: text("plan_type_label"),
    orgType: text("org_type"),
    orgName: text("org_name"),
    orgMarketingName: text("org_marketing_name"),
    planName: text("plan_name"),
    orgWebsite: text("org_website"),
    geographyName: text("geography_name"),
    /** Employer/union group plan (800-series): not sold to individuals. */
    isEmployerGroup: boolean("is_employer_group").notNull().default(false),
    isSnp: boolean("is_snp").notNull().default(false),
    snpType: text("snp_type"),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: "cms_plan_benefit_packages_pk", columns: [t.planYear, t.bidId] }),
    index("cms_plan_benefit_packages_contract_idx").on(t.planYear, t.contractId),
    index("cms_plan_benefit_packages_type_idx").on(t.planYear, t.planType),
  ],
);

export const cmsPlanBenefitSectionsTable = pgTable(
  "cms_plan_benefit_sections",
  {
    planYear: integer("plan_year").notNull(),
    bidId: text("bid_id").notNull(),
    /** CMS file name without "pbp_" and ".txt", e.g. "b16_dental", "mrx_tier". */
    section: text("section").notNull(),
    /** Order within the plan for files with several rows per plan; 0 otherwise. */
    rowSeq: integer("row_seq").notNull().default(0),
    /** Lower-case CMS column name -> CMS text value; empty values omitted. */
    data: jsonb("data").$type<Record<string, string>>().notNull(),
  },
  (t) => [
    primaryKey({
      name: "cms_plan_benefit_sections_pk",
      columns: [t.planYear, t.bidId, t.section, t.rowSeq],
    }),
    foreignKey({
      name: "cms_plan_benefit_sections_pkg_fk",
      columns: [t.planYear, t.bidId],
      foreignColumns: [cmsPlanBenefitPackagesTable.planYear, cmsPlanBenefitPackagesTable.bidId],
    }).onDelete("cascade"),
  ],
);

export const cmsPlanServiceAreasTable = pgTable(
  "cms_plan_service_areas",
  {
    planYear: integer("plan_year").notNull(),
    bidId: text("bid_id").notNull(),
    /** CMS 5-digit county code (SSA state+county code, NOT FIPS: Tarrant TX = 45910). */
    countyCode: text("county_code").notNull(),
    stateCode: text("state_code"),
    countyName: text("county_name"),
    /** CMS flags kept as CMS text: "1" = yes. */
    pendingFlag: text("pending_flag"),
    partialFlag: text("partial_flag"),
  },
  (t) => [
    primaryKey({
      name: "cms_plan_service_areas_pk",
      columns: [t.planYear, t.bidId, t.countyCode],
    }),
    foreignKey({
      name: "cms_plan_service_areas_pkg_fk",
      columns: [t.planYear, t.bidId],
      foreignColumns: [cmsPlanBenefitPackagesTable.planYear, cmsPlanBenefitPackagesTable.bidId],
    }).onDelete("cascade"),
    // "Which plans serve this county?" — the lookup an agent actually runs.
    index("cms_plan_service_areas_county_idx").on(t.planYear, t.countyCode),
  ],
);

/** Regional plans (Regional PPO, PDP) serve a CMS region, not counties. */
export const cmsPlanRegionsTable = pgTable(
  "cms_plan_regions",
  {
    planYear: integer("plan_year").notNull(),
    bidId: text("bid_id").notNull(),
    /** "MA" or "PDP". */
    regionType: text("region_type").notNull(),
    regionCode: text("region_code").notNull(),
    regionName: text("region_name"),
    pendingFlag: text("pending_flag"),
    partialFlag: text("partial_flag"),
  },
  (t) => [
    primaryKey({
      name: "cms_plan_regions_pk",
      columns: [t.planYear, t.bidId, t.regionType, t.regionCode],
    }),
    foreignKey({
      name: "cms_plan_regions_pkg_fk",
      columns: [t.planYear, t.bidId],
      foreignColumns: [cmsPlanBenefitPackagesTable.planYear, cmsPlanBenefitPackagesTable.bidId],
    }).onDelete("cascade"),
    index("cms_plan_regions_region_idx").on(t.planYear, t.regionType, t.regionCode),
  ],
);

export type CmsPlanBenefitPackage = typeof cmsPlanBenefitPackagesTable.$inferSelect;
