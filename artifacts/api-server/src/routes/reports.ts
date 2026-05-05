import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, sql, inArray, count, sum } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  ahipRecordsTable,
  contactsTable,
  leadsTable,
  dealsTable,
  pipelinesTable,
  pipelineStagesTable,
  dealStageHistoryTable,
  activitiesTable,
  messagesTable,
  messageThreadsTable,
  dataExportLogTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { randomUUID } from "crypto";

const router: IRouter = Router();

function parseRange(req: Request) {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

async function logExport(orgId: string, userId: string | null, exportType: string, filters: unknown, recordCount: number) {
  await db.insert(dataExportLogTable).values({
    id: randomUUID(),
    orgId,
    userId: userId ?? undefined,
    exportType,
    filters: filters as Record<string, unknown>,
    recordCount,
  });
}

// ─── Agent Performance Report ─────────────────────────────────────────────────
router.get(
  "/reports/agent-performance",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager", "agent_support"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);
    const { managerId, agentId } = req.query as { managerId?: string; agentId?: string };

    const agentFilter = [eq(agentsTable.orgId, authReq.orgId)];
    if (managerId) agentFilter.push(eq(agentsTable.managerId, managerId));
    if (agentId) agentFilter.push(eq(agentsTable.id, agentId));

    const agents = await db
      .select({
        id: agentsTable.id,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        email: agentsTable.email,
        status: agentsTable.status,
        managerId: agentsTable.managerId,
      })
      .from(agentsTable)
      .where(and(...agentFilter));

    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) { res.json([]); return; }

    // Parallel aggregation queries
    const [
      contactCounts,
      callCounts,
      // Per-agent SMS sent: join through contacts.assignedAgentId
      smsPerAgent,
      // Per-agent email sent: join through contacts.assignedAgentId
      emailPerAgent,
      dealsCounts,
      enrollCounts,
      licenses,
      certifications,
      ahipRecords,
    ] = await Promise.all([
      // Contacts assigned to each agent
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.assignedAgentId, agentIds)))
        .groupBy(contactsTable.assignedAgentId),

      // Calls logged (activities type=call_log in range, authored by agent's user — fallback: all org calls)
      db.select({ agentId: activitiesTable.createdBy, cnt: count() })
        .from(activitiesTable)
        .where(and(
          eq(activitiesTable.orgId, authReq.orgId),
          eq(activitiesTable.type, "call_log"),
          gte(activitiesTable.createdAt, start),
          lte(activitiesTable.createdAt, end),
        ))
        .groupBy(activitiesTable.createdBy),

      // SMS sent per agent — via contact.assignedAgentId
      db.select({
        agentId: contactsTable.assignedAgentId,
        cnt: count(),
      })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(
          eq(messageThreadsTable.orgId, authReq.orgId),
          eq(messageThreadsTable.channel, "sms"),
          eq(messagesTable.direction, "outbound"),
          gte(messagesTable.createdAt, start),
          lte(messagesTable.createdAt, end),
          inArray(contactsTable.assignedAgentId, agentIds),
        ))
        .groupBy(contactsTable.assignedAgentId),

      // Email sent per agent — via contact.assignedAgentId
      db.select({
        agentId: contactsTable.assignedAgentId,
        cnt: count(),
      })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(
          eq(messageThreadsTable.orgId, authReq.orgId),
          eq(messageThreadsTable.channel, "email"),
          eq(messagesTable.direction, "outbound"),
          gte(messagesTable.createdAt, start),
          lte(messagesTable.createdAt, end),
          inArray(contactsTable.assignedAgentId, agentIds),
        ))
        .groupBy(contactsTable.assignedAgentId),

      // Deals won per agent in range
      db.select({ agentId: dealsTable.assignedAgentId, cnt: count(), totalValue: sum(dealsTable.valueEst) })
        .from(dealsTable)
        .where(and(
          eq(dealsTable.orgId, authReq.orgId),
          eq(dealsTable.status, "won"),
          inArray(dealsTable.assignedAgentId, agentIds),
          gte(dealsTable.wonAt, start),
          lte(dealsTable.wonAt, end),
        ))
        .groupBy(dealsTable.assignedAgentId),

      // Enrolled contacts per agent
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(
          eq(contactsTable.orgId, authReq.orgId),
          eq(contactsTable.status, "enrolled"),
          inArray(contactsTable.assignedAgentId, agentIds),
        ))
        .groupBy(contactsTable.assignedAgentId),

      // License status per agent
      db.select({
        agentId: stateLicensesTable.agentId,
        status: stateLicensesTable.status,
        cnt: count(),
      })
        .from(stateLicensesTable)
        .where(inArray(stateLicensesTable.agentId, agentIds))
        .groupBy(stateLicensesTable.agentId, stateLicensesTable.status),

      // Certifications passed
      db.select({ agentId: carrierCertificationsTable.agentId, cnt: count() })
        .from(carrierCertificationsTable)
        .where(and(
          inArray(carrierCertificationsTable.agentId, agentIds),
          eq(carrierCertificationsTable.status, "passed"),
        ))
        .groupBy(carrierCertificationsTable.agentId),

      // AHIP current year
      db.select({ agentId: ahipRecordsTable.agentId, status: ahipRecordsTable.status })
        .from(ahipRecordsTable)
        .where(and(
          inArray(ahipRecordsTable.agentId, agentIds),
          eq(ahipRecordsTable.certificationYear, new Date().getFullYear()),
        )),
    ]);

    const report = agents.map((agent) => {
      const agentLicenses = licenses.filter((l) => l.agentId === agent.id);
      const activeLicenses = agentLicenses.filter((l) => l.status === "active").reduce((s, l) => s + Number(l.cnt), 0);
      const expiringLicenses = agentLicenses.filter((l) => l.status === "pending").reduce((s, l) => s + Number(l.cnt), 0);
      const ahip = ahipRecords.find((r) => r.agentId === agent.id);

      // Compliance score: 0–100
      const hasActiveLicense = activeLicenses > 0 ? 25 : 0;
      const hasCert = Number(certifications.find((c) => c.agentId === agent.id)?.cnt ?? 0) > 0 ? 25 : 0;
      const hasAhip = ahip?.status === "passed" ? 25 : 0;
      const noExpiring = expiringLicenses === 0 ? 25 : 0;
      const complianceScore = hasActiveLicense + hasCert + hasAhip + noExpiring;

      return {
        agentId: agent.id,
        agentName: `${agent.firstName} ${agent.lastName}`,
        email: agent.email,
        status: agent.status,
        contactsWorked: Number(contactCounts.find((c) => c.agentId === agent.id)?.cnt ?? 0),
        callsLogged: Number(callCounts.find((c) => c.agentId === agent.id)?.cnt ?? 0),
        smsSent: Number(smsPerAgent.find((s) => s.agentId === agent.id)?.cnt ?? 0),
        emailSent: Number(emailPerAgent.find((e) => e.agentId === agent.id)?.cnt ?? 0),
        dealsWon: Number(dealsCounts.find((d) => d.agentId === agent.id)?.cnt ?? 0),
        dealValueWon: Number(dealsCounts.find((d) => d.agentId === agent.id)?.totalValue ?? 0),
        enrolledContacts: Number(enrollCounts.find((e) => e.agentId === agent.id)?.cnt ?? 0),
        complianceScore,
        licensesActive: activeLicenses,
        licensesExpiring: expiringLicenses,
        certificationsPassed: Number(certifications.find((c) => c.agentId === agent.id)?.cnt ?? 0),
        ahipStatus: ahip?.status ?? "not_started",
      };
    });

    res.json(report);
  },
);

// ─── Agent Performance CSV Export ─────────────────────────────────────────────
router.get(
  "/reports/agent-performance/export",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const agents = await db
      .select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName, email: agentsTable.email, status: agentsTable.status })
      .from(agentsTable)
      .where(eq(agentsTable.orgId, authReq.orgId));

    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) { res.setHeader("Content-Type", "text/csv"); res.send(""); return; }

    const [contactCounts, dealsCounts, enrollCounts, smsPerAgent, emailPerAgent] = await Promise.all([
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.assignedAgentId, agentIds)))
        .groupBy(contactsTable.assignedAgentId),
      db.select({ agentId: dealsTable.assignedAgentId, cnt: count() })
        .from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "won"), inArray(dealsTable.assignedAgentId, agentIds)))
        .groupBy(dealsTable.assignedAgentId),
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"), inArray(contactsTable.assignedAgentId, agentIds)))
        .groupBy(contactsTable.assignedAgentId),
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "sms"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end), inArray(contactsTable.assignedAgentId, agentIds)))
        .groupBy(contactsTable.assignedAgentId),
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "email"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end), inArray(contactsTable.assignedAgentId, agentIds)))
        .groupBy(contactsTable.assignedAgentId),
    ]);

    const csvRows = agents.map((a) => [
      `${a.firstName} ${a.lastName}`,
      a.email,
      a.status,
      String(contactCounts.find((c) => c.agentId === a.id)?.cnt ?? 0),
      String(dealsCounts.find((d) => d.agentId === a.id)?.cnt ?? 0),
      String(enrollCounts.find((e) => e.agentId === a.id)?.cnt ?? 0),
      String(smsPerAgent.find((s) => s.agentId === a.id)?.cnt ?? 0),
      String(emailPerAgent.find((e) => e.agentId === a.id)?.cnt ?? 0),
    ]);

    const header = ["Agent Name", "Email", "Status", "Contacts Worked", "Deals Won", "Enrolled Contacts", "SMS Sent", "Email Sent"];
    const csv = [header, ...csvRows].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "agent_performance_csv", { startDate: start, endDate: end }, agents.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="agent-performance-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

// ─── Pipeline Report ──────────────────────────────────────────────────────────
router.get(
  "/reports/pipeline",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager", "agent_support"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const [pipelines, stages, deals, stageHistory] = await Promise.all([
      db.select().from(pipelinesTable).where(eq(pipelinesTable.orgId, authReq.orgId)),
      db.select().from(pipelineStagesTable).innerJoin(pipelinesTable, eq(pipelineStagesTable.pipelineId, pipelinesTable.id))
        .where(eq(pipelinesTable.orgId, authReq.orgId)),
      db.select().from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), gte(dealsTable.createdAt, start), lte(dealsTable.createdAt, end))),
      // Stage history: for avg-time-in-stage and conversion rates
      db.select({
        dealId: dealStageHistoryTable.dealId,
        fromStageId: dealStageHistoryTable.fromStageId,
        toStageId: dealStageHistoryTable.toStageId,
        changedAt: dealStageHistoryTable.changedAt,
      })
        .from(dealStageHistoryTable)
        .innerJoin(dealsTable, eq(dealStageHistoryTable.dealId, dealsTable.id))
        .where(and(eq(dealsTable.orgId, authReq.orgId), gte(dealsTable.createdAt, start), lte(dealsTable.createdAt, end))),
    ]);

    // Build a map: dealId → sorted history entries by changedAt
    const historyByDeal = new Map<string, Array<{ fromStageId: string | null; toStageId: string | null; changedAt: Date }>>();
    for (const h of stageHistory) {
      if (!historyByDeal.has(h.dealId)) historyByDeal.set(h.dealId, []);
      historyByDeal.get(h.dealId)!.push({ fromStageId: h.fromStageId, toStageId: h.toStageId, changedAt: h.changedAt });
    }
    for (const entries of historyByDeal.values()) {
      entries.sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
    }

    // Per-stage avg time spent (ms), computed from history transitions
    function avgTimeInStage(stageId: string, pipelineDeals: typeof deals): number {
      const durations: number[] = [];
      for (const deal of pipelineDeals) {
        const history = historyByDeal.get(deal.id) ?? [];
        // Find when this deal entered the stage and when it left
        let enteredAt: Date | null = null;
        if (deal.stageId === stageId && history.length === 0) {
          // Deal still in stage, no history — use deal.createdAt as proxy
          enteredAt = deal.createdAt;
        }
        for (let idx = 0; idx < history.length; idx++) {
          const h = history[idx];
          if (h.toStageId === stageId) enteredAt = h.changedAt;
          if (h.fromStageId === stageId && enteredAt) {
            durations.push(h.changedAt.getTime() - enteredAt.getTime());
            enteredAt = null;
          }
        }
        // If still in stage (no exit found)
        if (enteredAt && deal.stageId === stageId) {
          durations.push(Date.now() - enteredAt.getTime());
        }
      }
      if (durations.length === 0) return 0;
      return Math.round(durations.reduce((s, d) => s + d, 0) / durations.length / (60 * 60 * 1000)); // hours
    }

    // Conversion rate: % of deals that moved from this stage to the next ordered stage
    function conversionRate(stageId: string, nextStageId: string | null, pipelineDeals: typeof deals): number {
      if (!nextStageId) return 0;
      let entered = 0, advanced = 0;
      for (const deal of pipelineDeals) {
        const history = historyByDeal.get(deal.id) ?? [];
        const passedThisStage = deal.stageId === stageId || history.some((h) => h.fromStageId === stageId || h.toStageId === stageId);
        if (!passedThisStage) continue;
        entered++;
        if (history.some((h) => h.fromStageId === stageId && h.toStageId === nextStageId)) advanced++;
      }
      return entered > 0 ? Math.round((advanced / entered) * 1000) / 10 : 0;
    }

    const pipelineReport = pipelines.map((p) => {
      const pStages = stages
        .filter((s) => s.pipeline_stages.pipelineId === p.id)
        .map((s) => s.pipeline_stages)
        .sort((a, b) => a.orderIndex - b.orderIndex);

      const pDeals = deals.filter((d) => d.pipelineId === p.id);

      const funnel = pStages.map((stage, idx) => {
        const nextStage = pStages[idx + 1] ?? null;
        const stageDeals = pDeals.filter((d) => d.stageId === stage.id);
        const won = pDeals.filter((d) => d.status === "won" && d.stageId === stage.id).length;
        const lost = pDeals.filter((d) => d.status === "lost" && d.stageId === stage.id).length;
        return {
          stageId: stage.id,
          stageName: stage.name,
          orderIndex: stage.orderIndex,
          dealCount: stageDeals.length,
          totalValue: stageDeals.reduce((s, d) => s + (d.valueEst ?? 0), 0),
          wonCount: won,
          lostCount: lost,
          conversionRate: conversionRate(stage.id, nextStage?.id ?? null, pDeals),
          avgTimeInStageHours: avgTimeInStage(stage.id, pDeals),
        };
      });

      const totalDeals = pDeals.length;
      const wonDeals = pDeals.filter((d) => d.status === "won").length;
      const lostDeals = pDeals.filter((d) => d.status === "lost").length;
      const totalWonValue = pDeals.filter((d) => d.status === "won").reduce((s, d) => s + (d.valueEst ?? 0), 0);

      // Per-agent breakdown of won deals in this pipeline
      const agentBreakdown: Record<string, { agentId: string; wonCount: number; totalValue: number }> = {};
      for (const deal of pDeals.filter((d) => d.status === "won" && d.assignedAgentId)) {
        const aid = deal.assignedAgentId!;
        if (!agentBreakdown[aid]) agentBreakdown[aid] = { agentId: aid, wonCount: 0, totalValue: 0 };
        agentBreakdown[aid].wonCount++;
        agentBreakdown[aid].totalValue += deal.valueEst ?? 0;
      }
      const byAgent = Object.values(agentBreakdown).sort((a, b) => b.wonCount - a.wonCount).slice(0, 10);

      return {
        pipelineId: p.id,
        pipelineName: p.name,
        totalDeals,
        wonDeals,
        lostDeals,
        winRate: totalDeals > 0 ? Math.round((wonDeals / totalDeals) * 1000) / 10 : 0,
        totalWonValue,
        funnel,
        byAgent,
      };
    });

    res.json(pipelineReport);
  },
);

// ─── Lead Source Report ───────────────────────────────────────────────────────
router.get(
  "/reports/leads",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager", "agent_support"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const [leads, contacts] = await Promise.all([
      db.select({
        id: leadsTable.id,
        source: leadsTable.source,
        status: leadsTable.status,
        createdAt: leadsTable.createdAt,
        convertedAt: leadsTable.convertedAt,
        contactId: leadsTable.contactId,
      })
        .from(leadsTable)
        .where(and(eq(leadsTable.orgId, authReq.orgId), gte(leadsTable.createdAt, start), lte(leadsTable.createdAt, end))),
      db.select({ id: contactsTable.id })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"))),
    ]);

    const enrolledIds = new Set(contacts.map((c) => c.id));

    const bySource: Record<string, { source: string; total: number; converted: number; enrolled: number }> = {};
    for (const lead of leads) {
      const src = lead.source ?? "Unknown";
      if (!bySource[src]) bySource[src] = { source: src, total: 0, converted: 0, enrolled: 0 };
      bySource[src].total++;
      if (lead.status === "converted" || lead.convertedAt) bySource[src].converted++;
      if (enrolledIds.has(lead.contactId)) bySource[src].enrolled++;
    }

    const sourceBreakdown = Object.values(bySource).map((s) => ({
      ...s,
      conversionRate: s.total > 0 ? Math.round((s.converted / s.total) * 1000) / 10 : 0,
      enrollmentRate: s.total > 0 ? Math.round((s.enrolled / s.total) * 1000) / 10 : 0,
    })).sort((a, b) => b.total - a.total);

    // Weekly trend
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const trendMap: Record<string, number> = {};
    for (const lead of leads) {
      const weekStart = new Date(Math.floor(lead.createdAt.getTime() / weekMs) * weekMs);
      const key = weekStart.toISOString().slice(0, 10);
      trendMap[key] = (trendMap[key] ?? 0) + 1;
    }
    const trend = Object.entries(trendMap).map(([date, cnt]) => ({ date, count: cnt })).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ sourceBreakdown, trend, totalLeads: leads.length, convertedLeads: leads.filter((l) => l.status === "converted").length });
  },
);

// ─── Compliance Matrix Report ─────────────────────────────────────────────────
router.get(
  "/reports/compliance-matrix",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const currentYear = new Date().getFullYear();
    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const [agents, licenses, certs, carriers, ahipAll] = await Promise.all([
      db.select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName, status: agentsTable.status })
        .from(agentsTable).where(and(eq(agentsTable.orgId, authReq.orgId), inArray(agentsTable.status, ["active", "onboarding"]))),
      db.select().from(stateLicensesTable).innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(eq(agentsTable.orgId, authReq.orgId)),
      db.select({ agentId: carrierCertificationsTable.agentId, carrierId: carrierCertificationsTable.carrierId, status: carrierCertificationsTable.status, certYear: carrierCertificationsTable.certificationYear })
        .from(carrierCertificationsTable).innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .where(eq(agentsTable.orgId, authReq.orgId)),
      db.select({ id: carriersTable.id, name: carriersTable.name }).from(carriersTable).where(eq(carriersTable.orgId, authReq.orgId)),
      db.select({ agentId: ahipRecordsTable.agentId, status: ahipRecordsTable.status, year: ahipRecordsTable.certificationYear })
        .from(ahipRecordsTable).innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
        .where(eq(agentsTable.orgId, authReq.orgId)),
    ]);

    const licenseMatrix = agents.map((agent) => {
      const agentLicenses = licenses.filter((l) => l.state_licenses.agentId === agent.id);
      return {
        agentId: agent.id,
        agentName: `${agent.firstName} ${agent.lastName}`,
        licenses: agentLicenses.map((l) => ({
          stateCode: l.state_licenses.stateCode,
          licenseType: l.state_licenses.licenseType,
          status: l.state_licenses.status,
          expiryDate: l.state_licenses.expiryDate,
          expiringIn90Days: l.state_licenses.expiryDate ? l.state_licenses.expiryDate <= in90 && l.state_licenses.expiryDate > now : false,
        })),
      };
    });

    const expiryHeatmap: Record<string, number> = {};
    for (const l of licenses) {
      if (l.state_licenses.expiryDate) {
        const key = `${l.state_licenses.expiryDate.getFullYear()}-${String(l.state_licenses.expiryDate.getMonth() + 1).padStart(2, "0")}`;
        expiryHeatmap[key] = (expiryHeatmap[key] ?? 0) + 1;
      }
    }
    const expiryByMonth = Object.entries(expiryHeatmap).map(([month, cnt]) => ({ month, count: cnt })).sort((a, b) => a.month.localeCompare(b.month));

    const carrierCertCompletion = carriers.map((carrier) => {
      const carrierCerts = certs.filter((c) => c.carrierId === carrier.id);
      const byYear: Record<number, { total: number; passed: number }> = {};
      for (const cert of carrierCerts) {
        const yr = cert.certYear ?? currentYear;
        if (!byYear[yr]) byYear[yr] = { total: 0, passed: 0 };
        byYear[yr].total++;
        if (cert.status === "passed") byYear[yr].passed++;
      }
      return {
        carrierId: carrier.id,
        carrierName: carrier.name,
        byYear: Object.entries(byYear).map(([year, data]) => ({
          year: Number(year),
          total: data.total,
          passed: data.passed,
          completionRate: data.total > 0 ? Math.round((data.passed / data.total) * 1000) / 10 : 0,
        })).sort((a, b) => b.year - a.year),
      };
    });

    const ahipByYear: Record<number, { total: number; passed: number }> = {};
    for (const record of ahipAll) {
      const yr = record.year ?? currentYear;
      if (!ahipByYear[yr]) ahipByYear[yr] = { total: 0, passed: 0 };
      ahipByYear[yr].total++;
      if (record.status === "passed") ahipByYear[yr].passed++;
    }
    const ahipTrend = Object.entries(ahipByYear).map(([year, data]) => ({
      year: Number(year),
      total: data.total,
      passed: data.passed,
      completionRate: data.total > 0 ? Math.round((data.passed / data.total) * 1000) / 10 : 0,
    })).sort((a, b) => a.year - b.year);

    res.json({ licenseMatrix, expiryByMonth, carrierCertCompletion, ahipTrend });
  },
);

// ─── Communications Report ────────────────────────────────────────────────────
router.get(
  "/reports/communications",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager", "agent_support"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const [
      smsCount,
      emailCount,
      aiAssistedSms,
      aiAssistedEmail,
      optOutSmsCount,
      optOutEmailCount,
      smsPerAgent,
      emailPerAgent,
      allMessages,
    ] = await Promise.all([
      db.select({ cnt: count() }).from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "sms"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),

      db.select({ cnt: count() }).from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "email"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),

      db.select({ cnt: count() }).from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "sms"), eq(messagesTable.aiAssisted, true), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),

      db.select({ cnt: count() }).from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "email"), eq(messagesTable.aiAssisted, true), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),

      // SMS opt-out contacts
      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.optOutSms, true))),

      // Email opt-out contacts
      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.optOutEmail, true))),

      // Per-agent SMS sent (via contact.assignedAgentId) — top 20 agents
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "sms"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end)))
        .groupBy(contactsTable.assignedAgentId)
        .limit(20),

      // Per-agent email sent — top 20 agents
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "email"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end)))
        .groupBy(contactsTable.assignedAgentId)
        .limit(20),

      // Weekly volume for trend chart
      db.select({ channel: messageThreadsTable.channel, sentAt: messagesTable.createdAt })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end))),
    ]);

    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const trendMap: Record<string, { date: string; sms: number; email: number }> = {};
    for (const msg of allMessages) {
      const weekStart = new Date(Math.floor(msg.sentAt.getTime() / weekMs) * weekMs);
      const key = weekStart.toISOString().slice(0, 10);
      if (!trendMap[key]) trendMap[key] = { date: key, sms: 0, email: 0 };
      if (msg.channel === "sms") trendMap[key].sms++;
      else trendMap[key].email++;
    }
    const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

    // Build per-agent leaderboard (merge SMS + email)
    const agentCommsMap: Record<string, { agentId: string; smsSent: number; emailSent: number }> = {};
    for (const s of smsPerAgent) {
      if (!s.agentId) continue;
      if (!agentCommsMap[s.agentId]) agentCommsMap[s.agentId] = { agentId: s.agentId, smsSent: 0, emailSent: 0 };
      agentCommsMap[s.agentId].smsSent = Number(s.cnt);
    }
    for (const e of emailPerAgent) {
      if (!e.agentId) continue;
      if (!agentCommsMap[e.agentId]) agentCommsMap[e.agentId] = { agentId: e.agentId, smsSent: 0, emailSent: 0 };
      agentCommsMap[e.agentId].emailSent = Number(e.cnt);
    }
    const byAgent = Object.values(agentCommsMap)
      .sort((a, b) => (b.smsSent + b.emailSent) - (a.smsSent + a.emailSent))
      .slice(0, 10);

    res.json({
      totalSms: Number(smsCount[0]?.cnt ?? 0),
      totalEmail: Number(emailCount[0]?.cnt ?? 0),
      aiAssistedSms: Number(aiAssistedSms[0]?.cnt ?? 0),
      aiAssistedEmail: Number(aiAssistedEmail[0]?.cnt ?? 0),
      optOutSmsContacts: Number(optOutSmsCount[0]?.cnt ?? 0),
      optOutEmailContacts: Number(optOutEmailCount[0]?.cnt ?? 0),
      trend,
      byAgent,
    });
  },
);

// ─── Retention Report ─────────────────────────────────────────────────────────
router.get(
  "/reports/retention",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager", "agent_support"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();

    // AEP window: October 15 – December 7 of current year
    const currentYear = now.getFullYear();
    const aepStart = new Date(currentYear, 9, 15); // Oct 15
    const aepEnd = new Date(currentYear, 11, 7);   // Dec 7
    const inAepWindow = now >= aepStart && now <= aepEnd;

    // OEP window: January 1 – March 31
    const oepStart = new Date(currentYear, 0, 1);
    const oepEnd = new Date(currentYear, 2, 31);
    const inOepWindow = now >= oepStart && now <= oepEnd;

    // 30 days from now for birthdays/anniversaries
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const atRiskCutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [enrolled, lost, atRisk, birthdayContacts, monthlyEnrolledRaw, monthlyLostRaw] = await Promise.all([
      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"))),

      db.select({ cnt: count() }).from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "lost"))),

      // At-risk = enrolled contacts with no activity update in past 60 days
      db.select({ cnt: count() }).from(contactsTable)
        .where(and(
          eq(contactsTable.orgId, authReq.orgId),
          eq(contactsTable.status, "enrolled"),
          lte(contactsTable.updatedAt, atRiskCutoff),
        )),

      // Contacts with dob whose birthday falls within next 30 days
      db.select({ cnt: count() }).from(contactsTable)
        .where(and(
          eq(contactsTable.orgId, authReq.orgId),
          sql`EXTRACT(MONTH FROM ${contactsTable.dob}) = ANY(ARRAY[${sql.raw(String(now.getMonth() + 1))}, ${sql.raw(String(in30.getMonth() + 1))}])`,
          sql`EXTRACT(DAY FROM ${contactsTable.dob}) BETWEEN ${sql.raw(String(now.getDate()))} AND ${sql.raw(String(in30.getDate()))} OR EXTRACT(MONTH FROM ${contactsTable.dob}) != ${sql.raw(String(now.getMonth() + 1))}`,
        )),

      // Monthly enrolled contacts trend (last 12 months) — grouped by creation month
      db.select({
        yearMonth: sql<string>`TO_CHAR(${contactsTable.createdAt}, 'YYYY-MM')`,
        cnt: count(),
      })
        .from(contactsTable)
        .where(and(
          eq(contactsTable.orgId, authReq.orgId),
          eq(contactsTable.status, "enrolled"),
          gte(contactsTable.createdAt, new Date(now.getFullYear() - 1, now.getMonth(), 1)),
        ))
        .groupBy(sql`TO_CHAR(${contactsTable.createdAt}, 'YYYY-MM')`),

      // Monthly lost contacts trend (last 12 months)
      db.select({
        yearMonth: sql<string>`TO_CHAR(${contactsTable.updatedAt}, 'YYYY-MM')`,
        cnt: count(),
      })
        .from(contactsTable)
        .where(and(
          eq(contactsTable.orgId, authReq.orgId),
          eq(contactsTable.status, "lost"),
          gte(contactsTable.updatedAt, new Date(now.getFullYear() - 1, now.getMonth(), 1)),
        ))
        .groupBy(sql`TO_CHAR(${contactsTable.updatedAt}, 'YYYY-MM')`),
    ]);

    const enrolledCount = Number(enrolled[0]?.cnt ?? 0);
    const lostCount = Number(lost[0]?.cnt ?? 0);
    const atRiskCount = Number(atRisk[0]?.cnt ?? 0);
    const retentionRate = (enrolledCount + lostCount) > 0
      ? Math.round((enrolledCount / (enrolledCount + lostCount)) * 1000) / 10
      : 0;

    // Build monthly trend — merge enrolled + lost by month
    const monthlyMap: Record<string, { month: string; enrolled: number; lost: number }> = {};
    for (const r of monthlyEnrolledRaw) {
      const m = r.yearMonth;
      if (!monthlyMap[m]) monthlyMap[m] = { month: m, enrolled: 0, lost: 0 };
      monthlyMap[m].enrolled = Number(r.cnt);
    }
    for (const r of monthlyLostRaw) {
      const m = r.yearMonth;
      if (!monthlyMap[m]) monthlyMap[m] = { month: m, enrolled: 0, lost: 0 };
      monthlyMap[m].lost = Number(r.cnt);
    }
    const monthlyTrend = Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month));

    res.json({
      enrolledContacts: enrolledCount,
      lostContacts: lostCount,
      atRiskContacts: atRiskCount,
      retentionRate,
      atRiskRate: enrolledCount > 0 ? Math.round((atRiskCount / enrolledCount) * 1000) / 10 : 0,
      upcomingBirthdays: Number(birthdayContacts[0]?.cnt ?? 0),
      monthlyTrend,
      aepWindow: { start: aepStart.toISOString(), end: aepEnd.toISOString(), isActive: inAepWindow },
      oepWindow: { start: oepStart.toISOString(), end: oepEnd.toISOString(), isActive: inOepWindow },
      // Re-enrollment opportunity: enrolled contacts eligible for AEP/OEP changes
      reEnrollmentOpportunity: inAepWindow || inOepWindow ? enrolledCount : 0,
    });
  },
);

export default router;
