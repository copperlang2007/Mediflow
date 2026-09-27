import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, isNull, lt, count, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  taskInstancesTable,
  notificationsTable,
  contactsTable,
  activitiesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { auditMiddleware, scopeToRouter } from "../middlewares/auditMiddleware";
import { safeLimit } from "../lib/listGuards";
import { can, type Role } from "../lib/permissions";
import { leadContactsWhere } from "../lib/metrics/leads";
import { getAhipCoverage } from "../lib/agents/ahipCoverage";
import { expiredLicenseWhere } from "../lib/licenses/licenseStatus";

const router: IRouter = Router();

// Group-level audit: all dashboard reads are logged (HIPAA activity reporting).
router.use(scopeToRouter(router, auditMiddleware("dashboard", undefined, { includeReads: true })));

router.get("/dashboard/stats", requireAuth, requirePermission("dashboard", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const orgId = authReq.orgId;

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const currentYear = now.getFullYear();

  const [
    allAgents,
    licenses30,
    licenses60,
    licenses90,
    openTasks,
    overdueTasks,
    openLeads,
    unreadNotif,
    ahipCoverage,
    totalContacts,
    alertLicenses,
    expiredLicenses,
  ] = await Promise.all([
    db.select().from(agentsTable).where(eq(agentsTable.orgId, orgId)),
    db
      .select({ id: stateLicensesTable.id })
      .from(stateLicensesTable)
      .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          eq(stateLicensesTable.status, "active"),
          sql`${stateLicensesTable.expiryDate} <= ${in30}`,
          sql`${stateLicensesTable.expiryDate} > ${now}`
        )
      ),
    db
      .select({ id: stateLicensesTable.id })
      .from(stateLicensesTable)
      .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          eq(stateLicensesTable.status, "active"),
          sql`${stateLicensesTable.expiryDate} <= ${in60}`,
          sql`${stateLicensesTable.expiryDate} > ${now}`
        )
      ),
    db
      .select({ id: stateLicensesTable.id })
      .from(stateLicensesTable)
      .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          eq(stateLicensesTable.status, "active"),
          sql`${stateLicensesTable.expiryDate} <= ${in90}`,
          sql`${stateLicensesTable.expiryDate} > ${now}`
        )
      ),
    db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgId),
          sql`${taskInstancesTable.status} IN ('open', 'in_progress')`
        )
      ),
    db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgId),
          sql`${taskInstancesTable.status} IN ('open', 'in_progress')`,
          sql`${taskInstancesTable.dueDate} < ${now}`
        )
      ),
    // Leads = CRM contacts whose status is Lead (shared definition in
    // lib/metrics/leads.ts) — the same number the Clients & Leads page and
    // the "Your book" donut show. The `leads` table is the inbound queue's
    // routing record and is not what agents mean by "my leads".
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contactsTable)
      .where(leadContactsWhere(orgId)),
    db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.orgId, orgId),
          eq(notificationsTable.userId, authReq.userId),
          isNull(notificationsTable.readAt)
        )
      ),
    getAhipCoverage(orgId, currentYear),
    db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(and(eq(contactsTable.orgId, orgId), isNull(contactsTable.deletedAt))),
    db
      .select({
        agentId: agentsTable.id,
        agentFirst: agentsTable.firstName,
        agentLast: agentsTable.lastName,
        stateCode: stateLicensesTable.stateCode,
        licenseType: stateLicensesTable.licenseType,
        expiryDate: stateLicensesTable.expiryDate,
      })
      .from(stateLicensesTable)
      .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          eq(stateLicensesTable.status, "active"),
          sql`${stateLicensesTable.expiryDate} <= ${in90}`,
          sql`${stateLicensesTable.expiryDate} > ${now}`
        )
      )
      .orderBy(stateLicensesTable.expiryDate)
      .limit(10),
    // Licenses already past their expiry date (shared definition), for
    // agents still on the team.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(stateLicensesTable)
      .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          sql`${agentsTable.status} IN ('onboarding', 'active', 'suspended')`,
          expiredLicenseWhere(now),
        ),
      ),
  ]);

  const agentsByStatus = {
    onboarding: 0,
    active: 0,
    suspended: 0,
    offboarding: 0,
    offboarded: 0,
  };
  for (const agent of allAgents) {
    if (agent.status in agentsByStatus) {
      agentsByStatus[agent.status as keyof typeof agentsByStatus]++;
    }
  }


  const agentsWithExpiringLicenses = alertLicenses.map((row) => {
    const daysUntilExpiry = row.expiryDate
      ? Math.ceil(
          (row.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        )
      : 0;
    return {
      agentId: row.agentId,
      agentName: `${row.agentFirst} ${row.agentLast}`,
      stateCode: row.stateCode,
      licenseType: row.licenseType,
      expiryDate: row.expiryDate,
      daysUntilExpiry,
    };
  });

  res.json({
    totalAgents: allAgents.length,
    agentsByStatus,
    licensesExpiringIn30Days: licenses30.length,
    licensesExpiringIn60Days: licenses60.length,
    licensesExpiringIn90Days: licenses90.length,
    openTasksCount: openTasks.length,
    overdueTasks: overdueTasks.length,
    openLeadsCount: Number(openLeads[0]?.n ?? 0),
    unreadNotificationsCount: unreadNotif.length,
    // Shared with Certifications / Renewals (lib/agents/ahipCoverage.ts).
    ahipCompletionRateCurrent: ahipCoverage.completionRate,
    ahipCompleteCount: ahipCoverage.complete,
    agentsRequiringAhip: ahipCoverage.agentsRequiringAhip,
    licensesExpiredCount: Number(expiredLicenses[0]?.n ?? 0),
    totalContacts: totalContacts.length,
    agentsWithExpiringLicenses,
  });
});

router.get("/dashboard/activity", requireAuth, requirePermission("dashboard", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const { limit } = req.query as { limit?: string };
  const limitNum = safeLimit(limit, 20, 200);

  // Contact names are only included for roles that may read contacts; the
  // actor's name comes from users (org-scoped). Before this join every row
  // had userFullName = null and no subject, so six different activities on
  // six different clients rendered as the same three lines twice.
  const showContact = can(authReq.userRole as Role, "contact", "read");
  const activities = await db
    .select({
      id: activitiesTable.id,
      type: activitiesTable.type,
      body: activitiesTable.body,
      metadata: activitiesTable.metadata,
      createdBy: activitiesTable.createdBy,
      createdAt: activitiesTable.createdAt,
      contactId: activitiesTable.contactId,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
      userFullName: usersTable.fullName,
    })
    .from(activitiesTable)
    .leftJoin(
      contactsTable,
      and(eq(contactsTable.id, activitiesTable.contactId), eq(contactsTable.orgId, authReq.orgId)),
    )
    .leftJoin(
      usersTable,
      and(eq(usersTable.id, activitiesTable.createdBy), eq(usersTable.orgId, authReq.orgId)),
    )
    .where(eq(activitiesTable.orgId, authReq.orgId))
    .orderBy(sql`${activitiesTable.createdAt} DESC`, activitiesTable.id)
    .limit(limitNum);

  const enriched = activities.map((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    const contactName =
      showContact && (a.contactFirstName || a.contactLastName)
        ? `${a.contactFirstName ?? ""} ${a.contactLastName ?? ""}`.trim()
        : null;
    return {
      id: a.id,
      type: a.type,
      title: (meta?.title as string | undefined) ?? a.body ?? a.type,
      description: a.body ?? null,
      userId: a.createdBy ?? null,
      userFullName: a.userFullName ?? null,
      contactName,
      resourceType:
        (meta?.resourceType as string | null | undefined) ??
        (a.contactId && showContact ? "contact" : null),
      resourceId:
        (meta?.resourceId as string | null | undefined) ??
        (showContact ? (a.contactId ?? null) : null),
      createdAt: a.createdAt,
    };
  });

  res.json(enriched);
});

export default router;
