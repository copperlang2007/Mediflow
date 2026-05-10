import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, sql, count, sum, isNull } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
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
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"))),
      db.select({ cnt: count() }).from(messagesTable).innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id)).where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),
      db.select({ total: count(), passed: sum(sql<number>`CASE WHEN ${ahipRecordsTable.status} = 'passed' THEN 1 ELSE 0 END`) }).from(ahipRecordsTable).innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id)).where(eq(agentsTable.orgId, authReq.orgId)),
    ]);

    const wonCount = Number(dealsWon[0]?.cnt ?? 0);
    const lostCount = Number(dealsLost[0]?.cnt ?? 0);
    const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;
    const leadsTotal = Number(totalLeads[0]?.cnt ?? 0);
    const leadsPrior = Number(priorLeads[0]?.cnt ?? 0);
    const leadsChangePct = leadsPrior > 0 ? Math.round(((leadsTotal - leadsPrior) / leadsPrior) * 100) : null;
    const ahipTotal = Number(ahipStats[0]?.total ?? 0);
    const ahipPassed = Number(ahipStats[0]?.passed ?? 0);

    const rows: (string | number | null)[][] = [
      ["Metric", "Value"],
      ["Period Start", start.toISOString().slice(0, 10)],
      ["Period End", end.toISOString().slice(0, 10)],
      ["Active Agents", Number(activeAgents[0]?.cnt ?? 0)],
      ["Onboarding Agents", Number(onboardingAgents[0]?.cnt ?? 0)],
      ["New Leads (Period)", leadsTotal],
      ["Prior Period Leads", leadsPrior],
      ["Lead Change %", leadsChangePct != null ? leadsChangePct + "%" : "N/A"],
      ["Deals Won", wonCount],
      ["Deals Lost", lostCount],
      ["Win Rate", winRate + "%"],
      ["Won Value ($)", Number(dealsWon[0]?.val ?? 0)],
      ["Active Pipeline Value ($)", Number(activePipeline[0]?.val ?? 0)],
      ["Enrolled Members", Number(enrolledMembers[0]?.cnt ?? 0)],
      ["Outbound Messages", Number(commsVolume[0]?.cnt ?? 0)],
      ["AHIP Passed", ahipPassed],
      ["AHIP Total", ahipTotal],
      ["AHIP Pass Rate", ahipTotal > 0 ? Math.round((ahipPassed / ahipTotal) * 100) + "%" : "N/A"],
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
      ahipStats,
      licensesExpiringThisMonth,
      agentLicenseScores,
      agentCertScores,
      agentAhipScores,
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
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"), isNull(contactsTable.deletedAt))),

      db.select({ cnt: count() }).from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),

      db.select({ total: count(), passed: sum(sql<number>`CASE WHEN ${ahipRecordsTable.status} = 'passed' THEN 1 ELSE 0 END`) })
        .from(ahipRecordsTable)
        .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
        .where(eq(agentsTable.orgId, authReq.orgId)),

      // Licenses expiring this calendar month
      db.select({ cnt: count() }).from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(and(
          eq(agentsTable.orgId, authReq.orgId),
          gte(stateLicensesTable.expiryDate, monthStart),
          lte(stateLicensesTable.expiryDate, monthEnd),
        )),

      // Per-agent 4-pillar compliance scores for agency aggregate
      // Pillars (25 pts each): active license, active cert, passed AHIP, no expiring license (<30 days)
      db.select({
        agentId: agentsTable.id,
        hasActiveLicense: sql<number>`SUM(CASE WHEN ${stateLicensesTable.status} = 'active' THEN 1 ELSE 0 END)`,
        expiringLicenses: sql<number>`SUM(CASE WHEN ${stateLicensesTable.status} = 'active' AND ${stateLicensesTable.expiryDate} <= NOW() + INTERVAL '30 days' THEN 1 ELSE 0 END)`,
      }).from(agentsTable)
        .leftJoin(stateLicensesTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(eq(agentsTable.orgId, authReq.orgId))
        .groupBy(agentsTable.id),

      // Per-agent: has at least one passed/active certification
      db.select({
        agentId: carrierCertificationsTable.agentId,
        activeCerts: sql<number>`COUNT(*)`,
      }).from(carrierCertificationsTable)
        .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .where(and(eq(agentsTable.orgId, authReq.orgId), eq(carrierCertificationsTable.status, "passed")))
        .groupBy(carrierCertificationsTable.agentId),

      // Per-agent: has at least one passed AHIP record
      db.select({
        agentId: ahipRecordsTable.agentId,
        passedAhip: sql<number>`COUNT(*)`,
      }).from(ahipRecordsTable)
        .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
        .where(and(eq(agentsTable.orgId, authReq.orgId), eq(ahipRecordsTable.status, "passed")))
        .groupBy(ahipRecordsTable.agentId),
    ]);

    const leadsTotal = Number(totalLeads[0]?.cnt ?? 0);
    const leadsPrior = Number(priorLeads[0]?.cnt ?? 0);
    const leadsChangePct = leadsPrior > 0 ? Math.round(((leadsTotal - leadsPrior) / leadsPrior) * 100) : null;

    const wonCount = Number(dealsWon[0]?.cnt ?? 0);
    const lostCount = Number(dealsLost[0]?.cnt ?? 0);
    const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;

    const ahipTotal = Number(ahipStats[0]?.total ?? 0);
    const ahipPassed = Number(ahipStats[0]?.passed ?? 0);
    const ahipRate = ahipTotal > 0 ? Math.round((ahipPassed / ahipTotal) * 100) : 0;

    // Agency compliance score: 4-pillar average (25 pts each)
    // Pillar 1: hasActiveLicense  — at least 1 active state license
    // Pillar 2: hasCert           — at least 1 active carrier certification
    // Pillar 3: hasAhip           — at least 1 passed AHIP record
    // Pillar 4: noExpiringLicense — no active licenses expiring within 30 days
    const certByAgent = new Map(agentCertScores.map((r) => [r.agentId, Number(r.activeCerts)]));
    const ahipByAgent = new Map(agentAhipScores.map((r) => [r.agentId, Number(r.passedAhip)]));

    const agencyComplianceScore = agentLicenseScores.length > 0
      ? Math.round(
          agentLicenseScores.reduce((acc, a) => {
            const hasLic  = Number(a.hasActiveLicense) > 0 ? 25 : 0;
            const hasCert = (certByAgent.get(a.agentId) ?? 0) > 0 ? 25 : 0;
            const hasAhip = (ahipByAgent.get(a.agentId) ?? 0) > 0 ? 25 : 0;
            const noExp   = Number(a.expiringLicenses) === 0 ? 25 : 0;
            return acc + hasLic + hasCert + hasAhip + noExp;
          }, 0) / agentLicenseScores.length
        )
      : 0;

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
        ahipRate,
        ahipPassed,
        ahipTotal,
        licensesExpiringThisMonth: Number(licensesExpiringThisMonth[0]?.cnt ?? 0),
        aepEligibleContacts: inAep ? Number(enrolledMembers[0]?.cnt ?? 0) : 0,
        oepEligibleContacts: inOep ? Number(enrolledMembers[0]?.cnt ?? 0) : 0,
        agencyComplianceScore,
      },
    };
    setCachedReport(execCacheKey, result);
    res.json(result);
  },
);

export default router;
