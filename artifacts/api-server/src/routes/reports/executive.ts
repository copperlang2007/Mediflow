import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, count, sum, isNull, inArray } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  contactsTable,
  dealsTable,
  messagesTable,
  messageThreadsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
  requireExportConfirm,
} from "../../middlewares/requireAuth";
import { parseRange, logExport } from "./shared";
import {
  agencyComplianceScore,
  getAgentComplianceScores,
  type AgentComplianceScore,
} from "../../lib/compliance/agentComplianceScore";

/**
 * AHIP completion across ACTIVE agents for the plan year being sold: the
 * denominator is every active agent (not every AHIP row), so an agent with no
 * record counts as not certified instead of silently dropping out.
 */
function ahipStatsFromScores(scores: AgentComplianceScore[]) {
  const total = scores.length;
  const passed = scores.filter((s) => s.ahipCompleted).length;
  return {
    planYear: scores[0]?.planYear ?? null,
    total,
    passed,
    rate: total > 0 ? Math.round((passed / total) * 100) : 0,
  };
}

const router: IRouter = Router();

// ─── Short-TTL Report Cache ────────────────────────────────────────────────────
// Heavy aggregation endpoints (executive KPI, agent-performance) are cached for
// 5 minutes per org to avoid repeated full-table scans on frequent refreshes.
// Keys are scoped per-org so one org never sees another's data.
const REPORT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface CacheEntry<T> { data: T; expiresAt: number }
const reportCache = new Map<string, CacheEntry<unknown>>();

function getCachedReport<T>(key: string): T | null {
  const entry = reportCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) { reportCache.delete(key); return null; }
  return entry.data as T;
}

function setCachedReport(key: string, data: unknown): void {
  reportCache.set(key, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
}

// Purge stale entries every 10 minutes — non-blocking
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of reportCache) { if (now > v.expiresAt) reportCache.delete(k); }
}, 10 * 60 * 1000).unref();

// ─── Executive CSV Export ─────────────────────────────────────────────────────
router.get(
  "/reports/executive/export",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);
    const periodMs = end.getTime() - start.getTime();
    const priorStart = new Date(start.getTime() - periodMs);
    const priorEnd = new Date(start.getTime() - 1);

    const [activeAgents, onboardingAgents, totalLeads, priorLeads, dealsWon, dealsLost, activePipeline, enrolledMembers, commsVolume, ahipStats] = await Promise.all([
      db.select({ cnt: count() }).from(agentsTable).where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.status, "active"))),
      db.select({ cnt: count() }).from(agentsTable).where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.status, "onboarding"))),
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), gte(contactsTable.createdAt, start), lte(contactsTable.createdAt, end))),
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), gte(contactsTable.createdAt, priorStart), lte(contactsTable.createdAt, priorEnd))),
      db.select({ cnt: count(), val: sum(dealsTable.valueEst) }).from(dealsTable).where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "won"), gte(dealsTable.wonAt, start), lte(dealsTable.wonAt, end))),
      db.select({ cnt: count() }).from(dealsTable).where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "lost"), gte(dealsTable.updatedAt, start), lte(dealsTable.updatedAt, end))),
      db.select({ val: sum(dealsTable.valueEst) }).from(dealsTable).where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "open"))),
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.status, ["enrolled", "retained"]), isNull(contactsTable.deletedAt))),
      db.select({ cnt: count() }).from(messagesTable).innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id)).where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),
      getAgentComplianceScores({ orgId: authReq.orgId, statuses: ["active"] }),
    ]);

    const wonCount = Number(dealsWon[0]?.cnt ?? 0);
    const lostCount = Number(dealsLost[0]?.cnt ?? 0);
    const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;
    const leadsTotal = Number(totalLeads[0]?.cnt ?? 0);
    const leadsPrior = Number(priorLeads[0]?.cnt ?? 0);
    const leadsChangePct = leadsPrior > 0 ? Math.round(((leadsTotal - leadsPrior) / leadsPrior) * 100) : null;
    const ahip = ahipStatsFromScores(ahipStats);

    const rows: (string | number | null)[][] = [
      ["Metric", "Value"],
      ["Period Start", start.toISOString().slice(0, 10)],
      ["Period End", end.toISOString().slice(0, 10)],
      ["Active Agents", Number(activeAgents[0]?.cnt ?? 0)],
      ["Onboarding Agents", Number(onboardingAgents[0]?.cnt ?? 0)],
      ["New Clients & Leads Added (Period)", leadsTotal],
      ["Prior Period Clients & Leads Added", leadsPrior],
      ["Lead Change %", leadsChangePct != null ? leadsChangePct + "%" : "N/A"],
      ["Deals Won", wonCount],
      ["Deals Lost", lostCount],
      ["Win Rate", winRate + "%"],
      ["Won Value ($)", Number(dealsWon[0]?.val ?? 0)],
      ["Active Pipeline Value ($)", Number(activePipeline[0]?.val ?? 0)],
      ["Members (enrolled + retained)", Number(enrolledMembers[0]?.cnt ?? 0)],
      ["Outbound Messages", Number(commsVolume[0]?.cnt ?? 0)],
      ["AHIP Plan Year", ahip.planYear ?? "N/A"],
      ["Active Agents AHIP-Certified", ahip.passed],
      ["Active Agents", ahip.total],
      ["AHIP Completion Rate", ahip.total > 0 ? ahip.rate + "%" : "N/A"],
      ["Agency Compliance Score", agencyComplianceScore(ahipStats)],
    ];

    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "executive_csv", { startDate: start, endDate: end }, rows.length - 1);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="executive-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

// ─── Executive KPI Report ──────────────────────────────────────────────────────
router.get(
  "/reports/executive",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    // Cache key includes org + date range so different ranges don't collide
    const execCacheKey = `executive:${authReq.orgId}:${start.toISOString()}:${end.toISOString()}`;
    const cached = getCachedReport<object>(execCacheKey);
    if (cached) { res.json(cached); return; }

    const periodMs = end.getTime() - start.getTime();
    const priorStart = new Date(start.getTime() - periodMs);
    const priorEnd = new Date(start.getTime() - 1);

    const now = new Date();
    const execNow = now;
    const currentYear = now.getFullYear();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    // AEP: Oct 15 – Dec 7; OEP: Jan 1 – Mar 31
    const aepStart = new Date(currentYear, 9, 15);
    const aepEnd = new Date(currentYear, 11, 7);
    const oepStart = new Date(currentYear, 0, 1);
    const oepEnd = new Date(currentYear, 2, 31);
    const inAep = now >= aepStart && now <= aepEnd;
    const inOep = now >= oepStart && now <= oepEnd;

    const [
      activeAgents,
      onboardingAgents,
      totalLeads,
      priorLeads,
      dealsWon,
      dealsLost,
      activePipeline,
      enrolledMembers,
      commsVolume,
      activeAgentScores,
      licensesExpiringThisMonth,
    ] = await Promise.all([
      db.select({ cnt: count() }).from(agentsTable)
        .where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.status, "active"))),

      db.select({ cnt: count() }).from(agentsTable)
        .where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.status, "onboarding"))),

      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), gte(contactsTable.createdAt, start), lte(contactsTable.createdAt, end), isNull(contactsTable.deletedAt))),

      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), gte(contactsTable.createdAt, priorStart), lte(contactsTable.createdAt, priorEnd), isNull(contactsTable.deletedAt))),

      db.select({ cnt: count(), val: sum(dealsTable.valueEst) }).from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "won"), gte(dealsTable.wonAt, start), lte(dealsTable.wonAt, end), isNull(dealsTable.deletedAt))),

      db.select({ cnt: count() }).from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "lost"), gte(dealsTable.updatedAt, start), lte(dealsTable.updatedAt, end), isNull(dealsTable.deletedAt))),

      db.select({ val: sum(dealsTable.valueEst) }).from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "open"), isNull(dealsTable.deletedAt))),

      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.status, ["enrolled", "retained"]), isNull(contactsTable.deletedAt))),

      db.select({ cnt: count() }).from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),

      // Canonical per-agent compliance scores for ACTIVE agents — the AHIP
      // rate and the agency score both derive from this one read.
      getAgentComplianceScores({ orgId: authReq.orgId, statuses: ["active"] }),

      // Licenses expiring this calendar month
      db.select({ cnt: count() }).from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(and(
          eq(agentsTable.orgId, authReq.orgId),
          eq(agentsTable.status, "active"),
          eq(stateLicensesTable.status, "active"),
          gte(stateLicensesTable.expiryDate, monthStart),
          lte(stateLicensesTable.expiryDate, monthEnd),
        )),

    ]);

    const leadsTotal = Number(totalLeads[0]?.cnt ?? 0);
    const leadsPrior = Number(priorLeads[0]?.cnt ?? 0);
    const leadsChangePct = leadsPrior > 0 ? Math.round(((leadsTotal - leadsPrior) / leadsPrior) * 100) : null;

    const wonCount = Number(dealsWon[0]?.cnt ?? 0);
    const lostCount = Number(dealsLost[0]?.cnt ?? 0);
    const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;

    const ahip = ahipStatsFromScores(activeAgentScores);

    const result = {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      agents: {
        active: Number(activeAgents[0]?.cnt ?? 0),
        onboarding: Number(onboardingAgents[0]?.cnt ?? 0),
      },
      leads: {
        total: leadsTotal,
        priorPeriod: leadsPrior,
        changePercent: leadsChangePct,
      },
      deals: {
        won: wonCount,
        lost: lostCount,
        winRate,
        wonValue: Number(dealsWon[0]?.val ?? 0),
        activePipelineValue: Number(activePipeline[0]?.val ?? 0),
      },
      members: {
        enrolled: Number(enrolledMembers[0]?.cnt ?? 0),
      },
      communications: {
        outbound: Number(commsVolume[0]?.cnt ?? 0),
      },
      compliance: {
        ahipPlanYear: ahip.planYear,
        ahipRate: ahip.rate,
        ahipPassed: ahip.passed,
        ahipTotal: ahip.total,
        licensesExpiringThisMonth: Number(licensesExpiringThisMonth[0]?.cnt ?? 0),
        aepEligibleContacts: inAep ? Number(enrolledMembers[0]?.cnt ?? 0) : 0,
        oepEligibleContacts: inOep ? Number(enrolledMembers[0]?.cnt ?? 0) : 0,
        agencyComplianceScore: agencyComplianceScore(activeAgentScores),
      },
    };
    setCachedReport(execCacheKey, result);
    res.json(result);
  },
);

export default router;
