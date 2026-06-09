/**
 * AEP Command Center — read-only readiness cockpit for the Annual Enrollment
 * Period.
 *
 * Medicare Advantage / MAPD plans renew on January 1. The selling season (AEP)
 * runs Oct 15 – Dec 7, and Oct 1 is when the next plan year's details become
 * available — so every current member's annual review appointment should be SET
 * BEFORE Oct 1. The AEP annual-review generator (lib/aepRenewal/generate.ts,
 * shipped in #177) creates one "set the review appointment" task per current
 * MA/MAPD member each fall, keyed `aep_renewal:<year>:<contactId>`.
 *
 * This endpoint rolls those tasks + the member book up into a single readiness
 * view: how many members are up for renewal, how many already have a review
 * task, how many of those tasks are done vs open vs overdue, who's behind by
 * agent, and the season's key dates. It reads only existing tables — no schema
 * change — so it's a pure reporting surface.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, isNull, isNotNull, sql, desc } from "drizzle-orm";
import {
  db,
  contactsTable,
  taskInstancesTable,
  agentsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

/** Current-member statuses (mirrors the AEP generator's eligibility). */
const MEMBER_STATUSES = ["enrolled", "retained"] as const;
/** Plan types whose renewal drives the AEP annual-review motion. */
const MA_PLAN_TYPES = ["MA", "MAPD"] as const;

/** The deterministic trigger prefix the generator writes for a season. */
function renewalTriggerPrefix(year: number): string {
  return `aep_renewal:${year}:`;
}

/** Season key dates. The renewal the season preps is Jan 1 of `year + 1`. */
function keyDates(year: number): Record<string, string> {
  return {
    reviewDeadline: new Date(Date.UTC(year, 8, 30, 23, 59, 59)).toISOString(), // Sep 30
    newPlanDetails: new Date(Date.UTC(year, 9, 1)).toISOString(), // Oct 1
    aepEnrollmentStart: new Date(Date.UTC(year, 9, 15)).toISOString(), // Oct 15
    aepEnrollmentEnd: new Date(Date.UTC(year, 11, 7)).toISOString(), // Dec 7
    renewalDate: new Date(Date.UTC(year + 1, 0, 1)).toISOString(), // Jan 1 (next year)
  };
}

// GET /aep-cockpit[?year=YYYY]
router.get(
  "/aep-cockpit",
  requireAuth,
  requirePermission("retention_alert", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const parsedYear = parseInt((req.query.year as string) ?? "", 10);
    const year =
      Number.isFinite(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
        ? parsedYear
        : now.getUTCFullYear();
    const prefix = renewalTriggerPrefix(year);
    const likePattern = `${prefix}%`;

    // Eligible-member predicate — identical to the generator's.
    const memberWhere = and(
      eq(contactsTable.orgId, authReq.orgId),
      isNull(contactsTable.deletedAt),
      inArray(contactsTable.status, [...MEMBER_STATUSES]),
      inArray(contactsTable.currentPlanType, [...MA_PLAN_TYPES]),
    );

    // Renewal-task predicate for the season.
    const taskWhere = and(
      eq(taskInstancesTable.orgId, authReq.orgId),
      isNotNull(taskInstancesTable.autoAssignTrigger),
      sql`${taskInstancesTable.autoAssignTrigger} LIKE ${likePattern}`,
    );

    const [
      memberRows,
      taskStatusRows,
      overdueRow,
      withoutTaskRow,
      byAgentRows,
    ] = await Promise.all([
      // Members up for renewal, broken down by plan type.
      db
        .select({
          planType: contactsTable.currentPlanType,
          count: sql<number>`count(*)`,
        })
        .from(contactsTable)
        .where(memberWhere)
        .groupBy(contactsTable.currentPlanType),
      // Review tasks for the season, by status.
      db
        .select({
          status: taskInstancesTable.status,
          count: sql<number>`count(*)`,
        })
        .from(taskInstancesTable)
        .where(taskWhere)
        .groupBy(taskInstancesTable.status),
      // Overdue review tasks: still active, past their due date.
      db
        .select({ count: sql<number>`count(*)` })
        .from(taskInstancesTable)
        .where(
          and(
            taskWhere,
            inArray(taskInstancesTable.status, ["open", "in_progress"]),
            isNotNull(taskInstancesTable.dueDate),
            sql`${taskInstancesTable.dueDate} < ${now}`,
          ),
        ),
      // Eligible members WITHOUT a review task for the season (the gap).
      db
        .select({ count: sql<number>`count(*)` })
        .from(contactsTable)
        .where(
          and(
            memberWhere,
            sql`NOT EXISTS (
              SELECT 1 FROM task_instances ti
              WHERE ti.org_id = ${authReq.orgId}
                AND ti.auto_assign_trigger = ${prefix} || ${contactsTable.id}
            )`,
          ),
        ),
      // Per-agent breakdown of the season's review tasks.
      db
        .select({
          agentId: taskInstancesTable.agentId,
          agentFirstName: agentsTable.firstName,
          agentLastName: agentsTable.lastName,
          total: sql<number>`count(*)`,
          completed: sql<number>`count(*) FILTER (WHERE ${taskInstancesTable.status} = 'completed')`,
          open: sql<number>`count(*) FILTER (WHERE ${taskInstancesTable.status} IN ('open','in_progress'))`,
          overdue: sql<number>`count(*) FILTER (WHERE ${taskInstancesTable.status} IN ('open','in_progress') AND ${taskInstancesTable.dueDate} IS NOT NULL AND ${taskInstancesTable.dueDate} < ${now})`,
        })
        .from(taskInstancesTable)
        .leftJoin(agentsTable, eq(taskInstancesTable.agentId, agentsTable.id))
        .where(taskWhere)
        .groupBy(
          taskInstancesTable.agentId,
          agentsTable.firstName,
          agentsTable.lastName,
        )
        .orderBy(desc(sql`count(*)`))
        .limit(200),
    ]);

    const planBreakdown: Record<string, number> = {};
    let totalMembers = 0;
    for (const r of memberRows) {
      const n = Number(r.count);
      planBreakdown[r.planType ?? "unknown"] = n;
      totalMembers += n;
    }

    const taskCounts: Record<string, number> = {
      open: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const r of taskStatusRows) taskCounts[r.status] = Number(r.count);
    const totalTasks =
      taskCounts.open + taskCounts.in_progress + taskCounts.completed + taskCounts.cancelled;
    const activeTasks = taskCounts.open + taskCounts.in_progress;
    const membersWithoutTask = Number(withoutTaskRow[0]?.count ?? 0);
    const membersWithTask = Math.max(totalMembers - membersWithoutTask, 0);

    res.json({
      seasonYear: year,
      generatedAt: now.toISOString(),
      keyDates: keyDates(year),
      members: {
        total: totalMembers,
        byPlanType: planBreakdown,
        withReviewTask: membersWithTask,
        withoutReviewTask: membersWithoutTask,
        coverageRate: totalMembers > 0 ? membersWithTask / totalMembers : 0,
      },
      reviewTasks: {
        total: totalTasks,
        active: activeTasks,
        completed: taskCounts.completed,
        cancelled: taskCounts.cancelled,
        overdue: Number(overdueRow[0]?.count ?? 0),
        completionRate: totalTasks > 0 ? taskCounts.completed / totalTasks : 0,
      },
      byAgent: byAgentRows.map((r) => ({
        agentId: r.agentId,
        agentName:
          r.agentFirstName || r.agentLastName
            ? `${r.agentFirstName ?? ""} ${r.agentLastName ?? ""}`.trim()
            : "Unassigned",
        total: Number(r.total),
        completed: Number(r.completed),
        open: Number(r.open),
        overdue: Number(r.overdue),
      })),
    });
  },
);

export default router;
