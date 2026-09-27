import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, inArray, count, sum, isNull, sql } from "drizzle-orm";
import { activeLicenseFlagSql, activeLicenseWhere } from "../../lib/licenses/licenseStatus";
import {
  db,
  agentsTable,
  ahipRecordsTable,
  contactsTable,
  dealsTable,
  activitiesTable,
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
import { getAgentComplianceScores } from "../../lib/compliance/agentComplianceScore";
import { sellingPlanYear } from "../../lib/compliance/planYear";

const router: IRouter = Router();

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
        userId: agentsTable.userId,
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

    const reportNow = new Date();
    const in30Days = new Date(reportNow.getTime() + 30 * 86_400_000);

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
      ahipRecords,
      complianceScores,
    ] = await Promise.all([
      // Contacts assigned to each agent (exclude soft-deleted)
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.assignedAgentId, agentIds), isNull(contactsTable.deletedAt)))
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

      // SMS sent per agent — via contact.assignedAgentId (exclude soft-deleted contacts)
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
          isNull(contactsTable.deletedAt),
        ))
        .groupBy(contactsTable.assignedAgentId),

      // Email sent per agent — via contact.assignedAgentId (exclude soft-deleted contacts)
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
          isNull(contactsTable.deletedAt),
        ))
        .groupBy(contactsTable.assignedAgentId),

      // Deals won per agent in range (exclude soft-deleted)
      db.select({ agentId: dealsTable.assignedAgentId, cnt: count(), totalValue: sum(dealsTable.valueEst) })
        .from(dealsTable)
        .where(and(
          eq(dealsTable.orgId, authReq.orgId),
          eq(dealsTable.status, "won"),
          inArray(dealsTable.assignedAgentId, agentIds),
          gte(dealsTable.wonAt, start),
          lte(dealsTable.wonAt, end),
          isNull(dealsTable.deletedAt),
        ))
        .groupBy(dealsTable.assignedAgentId),

      // Enrolled contacts per agent (exclude soft-deleted)
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(
          eq(contactsTable.orgId, authReq.orgId),
          eq(contactsTable.status, "enrolled"),
          inArray(contactsTable.assignedAgentId, agentIds),
          isNull(contactsTable.deletedAt),
        ))
        .groupBy(contactsTable.assignedAgentId),

      // AHIP for the plan year being sold (same year the score uses)
      db.select({ agentId: ahipRecordsTable.agentId, status: ahipRecordsTable.status })
        .from(ahipRecordsTable)
        .where(and(
          inArray(ahipRecordsTable.agentId, agentIds),
          eq(ahipRecordsTable.certificationYear, sellingPlanYear()),
        )),

      // Canonical compliance score (lib/compliance/agentComplianceScore.ts)
      getAgentComplianceScores({ orgId: authReq.orgId, agentIds }),
    ]);

    // Build Map-based lookups once (O(N)) instead of .find() per agent (O(N*M)).
    // For 500 agents × 9 lookup arrays, this drops from ~4500*M ops to ~4500+M.
    const contactCountsByAgent = new Map(contactCounts.map((c) => [c.agentId, c]));
    const callCountsByAuthor = new Map(callCounts.map((c) => [c.agentId, c]));
    const smsByAgent = new Map(smsPerAgent.map((s) => [s.agentId, s]));
    const emailByAgent = new Map(emailPerAgent.map((e) => [e.agentId, e]));
    const dealsByAgent = new Map(dealsCounts.map((d) => [d.agentId, d]));
    const enrollByAgent = new Map(enrollCounts.map((e) => [e.agentId, e]));
    const ahipByAgent = new Map(ahipRecords.map((r) => [r.agentId, r]));
    const scoreByAgent = new Map(complianceScores.map((c) => [c.agentId, c]));

    const report = agents.map((agent) => {
      const score = scoreByAgent.get(agent.id);
      const ahip = ahipByAgent.get(agent.id);

      // call_log activities are authored by user_id; fall back to agent.id
      const calls = callCountsByAuthor.get(agent.userId) ?? callCountsByAuthor.get(agent.id);
      const dealsRow = dealsByAgent.get(agent.id);

      return {
        agentId: agent.id,
        agentName: `${agent.firstName} ${agent.lastName}`,
        email: agent.email,
        status: agent.status,
        contactsWorked: Number(contactCountsByAgent.get(agent.id)?.cnt ?? 0),
        callsLogged: Number(calls?.cnt ?? 0),
        smsSent: Number(smsByAgent.get(agent.id)?.cnt ?? 0),
        emailSent: Number(emailByAgent.get(agent.id)?.cnt ?? 0),
        dealsWon: Number(dealsRow?.cnt ?? 0),
        dealValueWon: Number(dealsRow?.totalValue ?? 0),
        enrolledContacts: Number(enrollByAgent.get(agent.id)?.cnt ?? 0),
        complianceScore: Math.round(score?.totalScore ?? 0),
        licensesActive: score?.activeLicenses ?? 0,
        licensesExpiring: score?.licensesExpiringSoon ?? 0,
        certificationsPassed: score?.activeCertifications ?? 0,
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
  requireExportConfirm,
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
        .where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.assignedAgentId, agentIds), isNull(contactsTable.deletedAt)))
        .groupBy(contactsTable.assignedAgentId),
      db.select({ agentId: dealsTable.assignedAgentId, cnt: count() })
        .from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), eq(dealsTable.status, "won"), inArray(dealsTable.assignedAgentId, agentIds), isNull(dealsTable.deletedAt)))
        .groupBy(dealsTable.assignedAgentId),
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"), inArray(contactsTable.assignedAgentId, agentIds), isNull(contactsTable.deletedAt)))
        .groupBy(contactsTable.assignedAgentId),
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "sms"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end), inArray(contactsTable.assignedAgentId, agentIds), isNull(contactsTable.deletedAt)))
        .groupBy(contactsTable.assignedAgentId),
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "email"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end), inArray(contactsTable.assignedAgentId, agentIds), isNull(contactsTable.deletedAt)))
        .groupBy(contactsTable.assignedAgentId),
    ]);

    // Build Map lookups once (O(N)) — avoid quadratic .find() over 5 arrays per agent.
    const contactCountsByAgent = new Map(contactCounts.map((c) => [c.agentId, c]));
    const dealsByAgent = new Map(dealsCounts.map((d) => [d.agentId, d]));
    const enrollByAgent = new Map(enrollCounts.map((e) => [e.agentId, e]));
    const smsByAgent = new Map(smsPerAgent.map((s) => [s.agentId, s]));
    const emailByAgent = new Map(emailPerAgent.map((e) => [e.agentId, e]));

    const csvRows = agents.map((a) => [
      `${a.firstName} ${a.lastName}`,
      a.email,
      a.status,
      String(contactCountsByAgent.get(a.id)?.cnt ?? 0),
      String(dealsByAgent.get(a.id)?.cnt ?? 0),
      String(enrollByAgent.get(a.id)?.cnt ?? 0),
      String(smsByAgent.get(a.id)?.cnt ?? 0),
      String(emailByAgent.get(a.id)?.cnt ?? 0),
    ]);

    const header = ["Agent Name", "Email", "Status", "Contacts Worked", "Deals Won", "Enrolled Contacts", "SMS Sent", "Email Sent"];
    const csv = [header, ...csvRows].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "agent_performance_csv", { startDate: start, endDate: end }, agents.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="agent-performance-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

export default router;
