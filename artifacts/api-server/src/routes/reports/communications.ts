import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, inArray, count } from "drizzle-orm";
import {
  db,
  agentsTable,
  contactsTable,
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
    // Enrich byAgent with agent names
    const agentIdsComms = Object.keys(agentCommsMap);
    const agentNameRows = agentIdsComms.length > 0
      ? await db
        .select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName })
        .from(agentsTable)
        .where(inArray(agentsTable.id, agentIdsComms))
      : [];
    const agentNameLookup: Record<string, string> = {};
    for (const a of agentNameRows) agentNameLookup[a.id] = `${a.firstName} ${a.lastName}`;

    const byAgent = Object.values(agentCommsMap)
      .map((a) => ({ ...a, agentName: agentNameLookup[a.agentId] ?? "Unknown Agent" }))
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

// ─── Communications CSV Export ────────────────────────────────────────────────
router.get(
  "/reports/communications/export",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const [smsPerAgent, emailPerAgent] = await Promise.all([
      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "sms"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end)))
        .groupBy(contactsTable.assignedAgentId),

      db.select({ agentId: contactsTable.assignedAgentId, cnt: count() })
        .from(messagesTable)
        .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
        .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
        .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messageThreadsTable.channel, "email"), eq(messagesTable.direction, "outbound"), gte(messagesTable.createdAt, start), lte(messagesTable.createdAt, end)))
        .groupBy(contactsTable.assignedAgentId),
    ]);

    const map: Record<string, { agentId: string; sms: number; email: number }> = {};
    for (const s of smsPerAgent) { if (s.agentId) { map[s.agentId] ??= { agentId: s.agentId, sms: 0, email: 0 }; map[s.agentId].sms = Number(s.cnt); } }
    for (const e of emailPerAgent) { if (e.agentId) { map[e.agentId] ??= { agentId: e.agentId, sms: 0, email: 0 }; map[e.agentId].email = Number(e.cnt); } }

    const agentIds = Object.keys(map);
    const agentNames = agentIds.length > 0
      ? await db.select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName })
          .from(agentsTable).where(inArray(agentsTable.id, agentIds))
      : [];
    const nameMap: Record<string, string> = {};
    for (const a of agentNames) nameMap[a.id] = `${a.firstName} ${a.lastName}`;

    const rows = Object.values(map)
      .sort((a, b) => (b.sms + b.email) - (a.sms + a.email))
      .map((r) => [nameMap[r.agentId] ?? r.agentId, r.sms, r.email, r.sms + r.email]);

    const header = ["Agent", "SMS Sent", "Email Sent", "Total"];
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "communications_csv", { startDate: start, endDate: end }, rows.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="communications-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

export default router;
