/**
 * Quoting Engine — CMS plan lookup (public data, no PHI, no org_id).
 *
 *   GET /quoting/plan-areas/states
 *   GET /quoting/plan-areas/counties?state=TX
 *   GET /quoting/plans?state=TX&countyCode=45910&q=&snp=all|only|exclude
 *       each plan carries a `card` (premium, out-of-pocket max, copays, extras)
 *       decoded from its CMS benefit rows by lib/planCard.ts
 *   GET /quoting/plans/:bidId
 *
 * Reads the `cms_plan_*` tables (latest plan year loaded). Employer/union group
 * plans are always hidden. Only plans that list a county are searchable here;
 * regional (PDP / regional PPO) plans are not covered yet. Search text is never
 * logged: failures log only a Postgres error code or the error class name
 * (database error messages can echo bound query values), searches log counts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  cmsPlanBenefitPackagesTable,
  cmsPlanBenefitSectionsTable,
  cmsPlanServiceAreasTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { buildPlanCard, CARD_COLUMNS, snpTypeLabel, type PlanCard, type Sections } from "../lib/planCard";

const router: IRouter = Router();

const PLAN_LIMIT = 300;
const SOURCE = "CMS Plan Benefit Package files";
const LOAD_ERROR = "Plan data could not be loaded right now.";

const makeLimiter = () =>
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => (req as AuthenticatedRequest).userId ?? req.ip ?? "unknown",
    message: { error: "Too many searches, wait a minute and try again." },
  });
// Separate budgets so browsing plan details cannot starve list searches.
const planLookupLimiter = makeLimiter();
const planDetailLimiter = makeLimiter();

const guards = [requireAuth, requirePermission("contact", "read"), planLookupLimiter];
const detailGuards = [requireAuth, requirePermission("contact", "read"), planDetailLimiter];

const stateCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/)
  .transform((s) => s.toUpperCase());

const CountiesQuery = z.object({ state: stateCodeSchema });
const PlansQuery = z.object({
  state: stateCodeSchema,
  countyCode: z.string().trim().regex(/^\d{5}$/),
  q: z.string().trim().max(60).optional(),
  snp: z.enum(["all", "only", "exclude"]).default("all"),
});
const BidParams = z.object({ bidId: z.string().regex(/^[A-Z0-9_]+$/).max(40) });

async function latestYear(): Promise<number | null> {
  const [row] = await db.select({ y: sql<number | null>`max(${cmsPlanBenefitPackagesTable.planYear})` }).from(cmsPlanBenefitPackagesTable);
  return row?.y ?? null;
}

/** Logs only a safe field: drizzle/pg messages can contain bound values (search text). */
function sendPlanLoadError(res: Response, err: unknown): void {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  const kind = typeof code === "string" ? code : err instanceof Error ? err.constructor.name : "unknown";
  logger.warn({ errKind: kind }, "quoting plans: query failed");
  res.status(500).json({ error: LOAD_ERROR });
}


/**
 * The card facts for many plans in one query. Only the columns the card reads
 * are pulled out of each section's JSON (never the whole section), so a county
 * with 300 plans stays a small response. Keys are bound parameters.
 */
async function loadCards(planYear: number, bidIds: string[]): Promise<Map<string, PlanCard | null>> {
  const cards = new Map<string, PlanCard | null>();
  if (bidIds.length === 0) return cards;
  const pick = sql.join(
    Object.entries(CARD_COLUMNS).map(
      ([section, cols]) =>
        sql`WHEN ${section}::text THEN jsonb_build_object(${sql.join(
          cols.map((c) => sql`${c}::text, ${cmsPlanBenefitSectionsTable.data} -> ${c}::text`),
          sql`, `,
        )})`,
    ),
    sql` `,
  );
  const rows = await db
    .select({
      bidId: cmsPlanBenefitSectionsTable.bidId,
      section: cmsPlanBenefitSectionsTable.section,
      data: sql<Record<string, string>>`jsonb_strip_nulls(CASE ${cmsPlanBenefitSectionsTable.section} ${pick} END)`,
    })
    .from(cmsPlanBenefitSectionsTable)
    .where(
      and(
        eq(cmsPlanBenefitSectionsTable.planYear, planYear),
        inArray(cmsPlanBenefitSectionsTable.bidId, bidIds),
        inArray(cmsPlanBenefitSectionsTable.section, Object.keys(CARD_COLUMNS)),
        eq(cmsPlanBenefitSectionsTable.rowSeq, 0),
      ),
    );
  const byBid = new Map<string, Sections>();
  for (const r of rows) {
    const sections = byBid.get(r.bidId) ?? {};
    sections[r.section] = [r.data];
    byBid.set(r.bidId, sections);
  }
  for (const bidId of bidIds) {
    try {
      cards.set(bidId, byBid.has(bidId) ? buildPlanCard(byBid.get(bidId)!) : null);
    } catch {
      cards.set(bidId, null); // a malformed row must not break the whole list
    }
  }
  return cards;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

router.get("/quoting/plan-areas/states", ...guards, async (_req: Request, res: Response): Promise<void> => {
  try {
    const planYear = await latestYear();
    if (planYear == null) {
      res.json({ data: [], planYear: null });
      return;
    }
    const rows = await db
      .selectDistinct({ stateCode: cmsPlanServiceAreasTable.stateCode })
      .from(cmsPlanServiceAreasTable)
      .innerJoin(cmsPlanBenefitPackagesTable, and(eq(cmsPlanBenefitPackagesTable.planYear, cmsPlanServiceAreasTable.planYear), eq(cmsPlanBenefitPackagesTable.bidId, cmsPlanServiceAreasTable.bidId)))
      .where(and(eq(cmsPlanServiceAreasTable.planYear, planYear), eq(cmsPlanBenefitPackagesTable.isEmployerGroup, false)))
      .orderBy(asc(cmsPlanServiceAreasTable.stateCode));
    res.json({ data: rows.filter((r) => r.stateCode), planYear });
  } catch (err) {
    sendPlanLoadError(res, err);
  }
});

router.get("/quoting/plan-areas/counties", ...guards, async (req: Request, res: Response): Promise<void> => {
  const parsed = CountiesQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Pick a 2-letter state." });
    return;
  }
  try {
    const planYear = await latestYear();
    if (planYear == null) {
      res.json({ data: [], planYear: null });
      return;
    }
    const rows = await db
      .select({
        countyCode: cmsPlanServiceAreasTable.countyCode,
        countyName: sql<string | null>`max(${cmsPlanServiceAreasTable.countyName})`,
      })
      .from(cmsPlanServiceAreasTable)
      .innerJoin(cmsPlanBenefitPackagesTable, and(eq(cmsPlanBenefitPackagesTable.planYear, cmsPlanServiceAreasTable.planYear), eq(cmsPlanBenefitPackagesTable.bidId, cmsPlanServiceAreasTable.bidId)))
      .where(
        and(eq(cmsPlanServiceAreasTable.planYear, planYear), eq(cmsPlanServiceAreasTable.stateCode, parsed.data.state), eq(cmsPlanBenefitPackagesTable.isEmployerGroup, false)),
      )
      .groupBy(cmsPlanServiceAreasTable.countyCode)
      .orderBy(sql`max(${cmsPlanServiceAreasTable.countyName})`, asc(cmsPlanServiceAreasTable.countyCode));
    res.json({ data: rows, planYear });
  } catch (err) {
    sendPlanLoadError(res, err);
  }
});

router.get("/quoting/plans", ...guards, async (req: Request, res: Response): Promise<void> => {
  const parsed = PlansQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Pick a state and a county (5-digit CMS county code). Search text can be up to 60 characters.",
    });
    return;
  }
  const { state: stateCode, countyCode, q, snp } = parsed.data;
  try {
    const planYear = await latestYear();
    if (planYear == null) {
      res.json({ data: [], planYear: null });
      return;
    }
    const conds = [
      eq(cmsPlanServiceAreasTable.planYear, planYear),
      eq(cmsPlanServiceAreasTable.countyCode, countyCode),
      eq(cmsPlanServiceAreasTable.stateCode, stateCode),
      eq(cmsPlanBenefitPackagesTable.isEmployerGroup, false),
    ];
    if (snp === "only") conds.push(eq(cmsPlanBenefitPackagesTable.isSnp, true));
    if (snp === "exclude") conds.push(eq(cmsPlanBenefitPackagesTable.isSnp, false));
    if (q) {
      const pat = `%${escapeLike(q)}%`;
      conds.push(or(ilike(cmsPlanBenefitPackagesTable.planName, pat), ilike(cmsPlanBenefitPackagesTable.orgName, pat), ilike(cmsPlanBenefitPackagesTable.orgMarketingName, pat))!);
    }
    const where = and(...conds);
    const [{ total }] = await db
      .select({ total: count() })
      .from(cmsPlanServiceAreasTable)
      .innerJoin(cmsPlanBenefitPackagesTable, and(eq(cmsPlanBenefitPackagesTable.planYear, cmsPlanServiceAreasTable.planYear), eq(cmsPlanBenefitPackagesTable.bidId, cmsPlanServiceAreasTable.bidId)))
      .where(where);
    const rows = await db
      .select({
        bidId: cmsPlanBenefitPackagesTable.bidId,
        contractId: cmsPlanBenefitPackagesTable.contractId,
        planId: cmsPlanBenefitPackagesTable.planId,
        segmentId: cmsPlanBenefitPackagesTable.segmentId,
        planName: cmsPlanBenefitPackagesTable.planName,
        orgName: cmsPlanBenefitPackagesTable.orgName,
        orgMarketingName: cmsPlanBenefitPackagesTable.orgMarketingName,
        planTypeLabel: cmsPlanBenefitPackagesTable.planTypeLabel,
        isSnp: cmsPlanBenefitPackagesTable.isSnp,
        snpType: cmsPlanBenefitPackagesTable.snpType,
        orgWebsite: cmsPlanBenefitPackagesTable.orgWebsite,
        partialFlag: cmsPlanServiceAreasTable.partialFlag,
      })
      .from(cmsPlanServiceAreasTable)
      .innerJoin(cmsPlanBenefitPackagesTable, and(eq(cmsPlanBenefitPackagesTable.planYear, cmsPlanServiceAreasTable.planYear), eq(cmsPlanBenefitPackagesTable.bidId, cmsPlanServiceAreasTable.bidId)))
      .where(where)
      .orderBy(asc(cmsPlanBenefitPackagesTable.orgMarketingName), asc(cmsPlanBenefitPackagesTable.planName), asc(cmsPlanBenefitPackagesTable.bidId))
      .limit(PLAN_LIMIT);
    const cards = await loadCards(planYear, rows.map((r) => r.bidId));
    const data = rows.map(({ partialFlag, ...r }) => ({
      ...r,
      snpType: snpTypeLabel(r.snpType),
      partial: partialFlag === "1",
      card: cards.get(r.bidId) ?? null,
    }));
    logger.info({ results: data.length, total }, "quoting plans: search ok");
    res.json({ data, total, truncated: total > PLAN_LIMIT, planYear, source: SOURCE });
  } catch (err) {
    sendPlanLoadError(res, err);
  }
});

router.get("/quoting/plans/:bidId", ...detailGuards, async (req: Request, res: Response): Promise<void> => {
  const parsed = BidParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "That plan id doesn't look right." });
    return;
  }
  try {
    const planYear = await latestYear();
    if (planYear == null) {
      res.status(404).json({ error: "Plan not found." });
      return;
    }
    const [plan] = await db
      .select()
      .from(cmsPlanBenefitPackagesTable)
      .where(and(eq(cmsPlanBenefitPackagesTable.planYear, planYear), eq(cmsPlanBenefitPackagesTable.bidId, parsed.data.bidId), eq(cmsPlanBenefitPackagesTable.isEmployerGroup, false)))
      .limit(1);
    if (!plan) {
      res.status(404).json({ error: "Plan not found." });
      return;
    }
    const rows = await db
      .select({ section: cmsPlanBenefitSectionsTable.section, data: cmsPlanBenefitSectionsTable.data })
      .from(cmsPlanBenefitSectionsTable)
      .where(and(eq(cmsPlanBenefitSectionsTable.planYear, planYear), eq(cmsPlanBenefitSectionsTable.bidId, plan.bidId)))
      .orderBy(asc(cmsPlanBenefitSectionsTable.section), asc(cmsPlanBenefitSectionsTable.rowSeq));
    const grouped: { section: string; rows: Record<string, string>[] }[] = [];
    for (const r of rows) {
      const last = grouped[grouped.length - 1];
      if (last && last.section === r.section) last.rows.push(r.data);
      else grouped.push({ section: r.section, rows: [r.data] });
    }
    const bySection: Sections = {};
    for (const g of grouped) bySection[g.section] = g.rows;
    let card: PlanCard | null = null;
    try {
      card = buildPlanCard(bySection);
    } catch {
      card = null;
    }
    res.json({ plan: { ...plan, snpType: snpTypeLabel(plan.snpType) }, sections: grouped, card, planYear, source: SOURCE });
  } catch (err) {
    sendPlanLoadError(res, err);
  }
});

export default router;
