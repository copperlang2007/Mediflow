import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, isNull, lt, count, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  taskInstancesTable,
  leadsTable,
  notificationsTable,
  ahipRecordsTable,
  contactsTable,
  activitiesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

// Group-level audit: all dashboard reads are logged (HIPAA activity reporting).
router.use(auditMiddleware("dashboard", undefined, { includeReads: true }));

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
    ahipRecords,
    totalContacts,
    alertLicenses,
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
    db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.orgId, orgId),
          sql`${leadsTable.status} IN ('new', 'contacted', 'qualified')`
        )
      ),
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
    db
      .select()
      .from(ahipRecordsTable)
      .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
      .where(
        and(
          eq(agentsTable.orgId, orgId),
          eq(ahipRecordsTable.certificationYear, currentYear)
        )
      ),
    db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(eq(contactsTable.orgId, orgId)),
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

  const ahipTotal = ahipRecords.length;
  const ahipCompleted = ahipRecords.filter(
    (r) => r.ahip_records.status === "passed"
  ).length;
  const ahipRate = ahipTotal > 0 ? (ahipCompleted / ahipTotal) * 100 : 0;

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
    openLeadsCount: openLeads.length,
    unreadNotificationsCount: unreadNotif.length,
    ahipCompletionRateCurrent: Math.round(ahipRate * 10) / 10,
    totalContacts: totalContacts.length,
    agentsWithExpiringLicenses,
  });
});

router.get("/dashboard/activity", requireAuth, requirePermission("dashboard", "read"), async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const { limit } = req.query as { limit?: string };
  const limitNum = Math.min(parseInt(limit ?? "20", 10) || 20, 100);

  const activities = await db
    .select({
      id: activitiesTable.id,
      type: activitiesTable.type,
      body: activitiesTable.body,
      metadata: activitiesTable.metadata,
      createdBy: activitiesTable.createdBy,
      createdAt: activitiesTable.createdAt,
    })
    .from(activitiesTable)
    .where(eq(activitiesTable.orgId, authReq.orgId))
    .orderBy(sql`${activitiesTable.createdAt} DESC`)
    .limit(limitNum);

  const enriched = activities.map((a) => ({
    id: a.id,
    type: a.type,
    title: (a.metadata as Record<string, unknown> | null)?.title ?? a.body ?? a.type,
    description: a.body ?? null,
    userId: a.createdBy ?? null,
    userFullName: null as string | null,
    resourceType: (a.metadata as Record<string, unknown> | null)?.resourceType as string | null ?? null,
    resourceId: (a.metadata as Record<string, unknown> | null)?.resourceId as string | null ?? null,
    createdAt: a.createdAt,
  }));

  res.json(enriched);
});

export default router;
