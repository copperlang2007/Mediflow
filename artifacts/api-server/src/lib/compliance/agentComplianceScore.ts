/**
 * The ONE agent compliance score.
 *
 * Before this module the roster, the agent profile, the Agent Performance
 * report and the Executive report each computed "compliance score" with a
 * different formula (40/30/20/10 vs. 4×25, "pending" read as "expiring", AHIP
 * from any year counting as current, licenses past their expiry date counting
 * as active). The same agent could read 100% on one screen and 50% on another.
 * Every surface now reads the score from here.
 *
 * Score (0–100), all credential checks evaluated against the plan year being
 * sold today (lib/compliance/planYear.ts) and the credential's own expiry date:
 *
 *   Licensing       40 pts — share of the agent's state licenses that are
 *                            `active` AND not past `expiry_date`.
 *   Certifications  30 pts — share of the agent's carrier certifications for
 *                            the plan year that are `passed`/`waived` AND not
 *                            past `expiry_date`.
 *   AHIP            20 pts — a `passed`/`waived` AHIP record for the plan year.
 *   Onboarding      10 pts — share of the latest onboarding checklist's items
 *                            that are completed or skipped.
 *
 * A pillar with no rows scores 0 (no licenses on file is not compliant).
 *
 * The pillars are expressed as SQL correlated to `agents.id` so the roster can
 * ORDER BY the exact same expression it displays — there is no second copy of
 * the formula in JS.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, agentsTable } from "@workspace/db";
import { sellingPlanYear } from "./planYear";

export const COMPLIANCE_WEIGHTS = {
  licensing: 40,
  certifications: 30,
  ahip: 20,
  onboarding: 10,
} as const;

export interface ComplianceScoreContext {
  now: Date;
  planYear: number;
}

export function complianceContext(now: Date = new Date()): ComplianceScoreContext {
  return { now, planYear: sellingPlanYear(now) };
}

/** Fraction (0–1) of licenses that are active and unexpired. */
function licenseFractionSql({ now }: ComplianceScoreContext): SQL<number> {
  return sql<number>`COALESCE((
    SELECT CAST(count(*) FILTER (
      WHERE sl.status = 'active' AND (sl.expiry_date IS NULL OR sl.expiry_date > ${now})
    ) AS FLOAT) / NULLIF(count(*), 0)
    FROM state_licenses sl WHERE sl.agent_id = agents.id
  ), 0)`;
}

/** Fraction (0–1) of plan-year carrier certs that are passed/waived and unexpired. */
function certFractionSql({ now, planYear }: ComplianceScoreContext): SQL<number> {
  return sql<number>`COALESCE((
    SELECT CAST(count(*) FILTER (
      WHERE cc.status IN ('passed', 'waived') AND (cc.expiry_date IS NULL OR cc.expiry_date > ${now})
    ) AS FLOAT) / NULLIF(count(*), 0)
    FROM carrier_certifications cc
    WHERE cc.agent_id = agents.id AND cc.certification_year = ${planYear}
  ), 0)`;
}

/** 1 when the agent holds a passed/waived AHIP for the plan year, else 0. */
function ahipFractionSql({ planYear }: ComplianceScoreContext): SQL<number> {
  return sql<number>`CASE WHEN EXISTS (
    SELECT 1 FROM ahip_records ar
    WHERE ar.agent_id = agents.id AND ar.certification_year = ${planYear}
      AND ar.status IN ('passed', 'waived')
  ) THEN 1 ELSE 0 END`;
}

/** Fraction (0–1) of the latest onboarding checklist's items that are done. */
function onboardingFractionSql(): SQL<number> {
  return sql<number>`COALESCE((
    SELECT CAST(count(*) FILTER (WHERE ci.status IN ('completed', 'skipped')) AS FLOAT) / NULLIF(count(*), 0)
    FROM checklist_items ci
    WHERE ci.run_id = (
      SELECT cr.id FROM checklist_runs cr
      WHERE cr.agent_id = agents.id AND cr.type = 'onboarding'
      ORDER BY cr.started_at DESC LIMIT 1
    )
  ), 0)`;
}

/** Total score expression (0–100), correlated to `agents.id`. */
export function complianceScoreSql(ctx: ComplianceScoreContext): SQL<number> {
  return sql<number>`(
    ${licenseFractionSql(ctx)} * ${COMPLIANCE_WEIGHTS.licensing} +
    ${certFractionSql(ctx)} * ${COMPLIANCE_WEIGHTS.certifications} +
    ${ahipFractionSql(ctx)} * ${COMPLIANCE_WEIGHTS.ahip} +
    ${onboardingFractionSql()} * ${COMPLIANCE_WEIGHTS.onboarding}
  )`;
}

export interface AgentComplianceScore {
  agentId: string;
  planYear: number;
  /** 0–100, one decimal. */
  totalScore: number;
  /** Each pillar as 0–100, one decimal. */
  licenseScore: number;
  certificationScore: number;
  ahipScore: number;
  onboardingScore: number;
  activeLicenses: number;
  totalLicenses: number;
  /** Active licenses whose expiry falls within the next 30 days. */
  licensesExpiringSoon: number;
  activeCertifications: number;
  totalCertifications: number;
  ahipCompleted: boolean;
  onboardingCompletedItems: number;
  onboardingTotalItems: number;
  onboardingComplete: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Compute the score for a set of agents in one query. Pass `agentIds` for a
 * specific set, or `statuses` to score every agent in the org with one of
 * those statuses.
 */
export async function getAgentComplianceScores(opts: {
  orgId: string;
  agentIds?: string[];
  statuses?: Array<(typeof agentsTable.$inferSelect)["status"]>;
  now?: Date;
}): Promise<AgentComplianceScore[]> {
  const ctx = complianceContext(opts.now);
  const { now, planYear } = ctx;
  const in30 = new Date(now.getTime() + 30 * 86_400_000);

  const conditions: SQL[] = [eq(agentsTable.orgId, opts.orgId)];
  if (opts.agentIds) {
    if (opts.agentIds.length === 0) return [];
    conditions.push(inArray(agentsTable.id, opts.agentIds));
  }
  if (opts.statuses) {
    if (opts.statuses.length === 0) return [];
    conditions.push(inArray(agentsTable.status, opts.statuses));
  }

  const rows = await db
    .select({
      agentId: agentsTable.id,
      licenseFraction: licenseFractionSql(ctx),
      certFraction: certFractionSql(ctx),
      ahipFraction: ahipFractionSql(ctx),
      onboardingFraction: onboardingFractionSql(),
      activeLicenses: sql<number>`(SELECT count(*) FROM state_licenses sl WHERE sl.agent_id = agents.id AND sl.status = 'active' AND (sl.expiry_date IS NULL OR sl.expiry_date > ${now}))`,
      totalLicenses: sql<number>`(SELECT count(*) FROM state_licenses sl WHERE sl.agent_id = agents.id)`,
      licensesExpiringSoon: sql<number>`(SELECT count(*) FROM state_licenses sl WHERE sl.agent_id = agents.id AND sl.status = 'active' AND sl.expiry_date > ${now} AND sl.expiry_date <= ${in30})`,
      activeCertifications: sql<number>`(SELECT count(*) FROM carrier_certifications cc WHERE cc.agent_id = agents.id AND cc.certification_year = ${planYear} AND cc.status IN ('passed', 'waived') AND (cc.expiry_date IS NULL OR cc.expiry_date > ${now}))`,
      totalCertifications: sql<number>`(SELECT count(*) FROM carrier_certifications cc WHERE cc.agent_id = agents.id AND cc.certification_year = ${planYear})`,
      onboardingCompletedItems: sql<number>`(SELECT count(*) FROM checklist_items ci WHERE ci.status IN ('completed', 'skipped') AND ci.run_id = (SELECT cr.id FROM checklist_runs cr WHERE cr.agent_id = agents.id AND cr.type = 'onboarding' ORDER BY cr.started_at DESC LIMIT 1))`,
      onboardingTotalItems: sql<number>`(SELECT count(*) FROM checklist_items ci WHERE ci.run_id = (SELECT cr.id FROM checklist_runs cr WHERE cr.agent_id = agents.id AND cr.type = 'onboarding' ORDER BY cr.started_at DESC LIMIT 1))`,
    })
    .from(agentsTable)
    .where(and(...conditions));

  return rows.map((r) => {
    const lic = Number(r.licenseFraction);
    const cert = Number(r.certFraction);
    const ahip = Number(r.ahipFraction);
    const onb = Number(r.onboardingFraction);
    const onboardingTotalItems = Number(r.onboardingTotalItems);
    const onboardingCompletedItems = Number(r.onboardingCompletedItems);
    return {
      agentId: r.agentId,
      planYear,
      totalScore: round1(
        lic * COMPLIANCE_WEIGHTS.licensing +
          cert * COMPLIANCE_WEIGHTS.certifications +
          ahip * COMPLIANCE_WEIGHTS.ahip +
          onb * COMPLIANCE_WEIGHTS.onboarding,
      ),
      licenseScore: round1(lic * 100),
      certificationScore: round1(cert * 100),
      ahipScore: ahip * 100,
      onboardingScore: round1(onb * 100),
      activeLicenses: Number(r.activeLicenses),
      totalLicenses: Number(r.totalLicenses),
      licensesExpiringSoon: Number(r.licensesExpiringSoon),
      activeCertifications: Number(r.activeCertifications),
      totalCertifications: Number(r.totalCertifications),
      ahipCompleted: ahip === 1,
      onboardingCompletedItems,
      onboardingTotalItems,
      onboardingComplete:
        onboardingTotalItems > 0 && onboardingCompletedItems >= onboardingTotalItems,
    };
  });
}

/** Mean of `totalScore` across agents, rounded to a whole number (0 when empty). */
export function agencyComplianceScore(scores: AgentComplianceScore[]): number {
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((s, a) => s + a.totalScore, 0) / scores.length);
}
