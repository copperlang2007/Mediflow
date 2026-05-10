import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, sql, count } from "drizzle-orm";
import {
  db,
  contactsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
  requireExportConfirm,
} from "../../middlewares/requireAuth";
import { logExport } from "./shared";

const router: IRouter = Router();

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

// ─── Retention CSV Export ─────────────────────────────────────────────────────
router.get(
  "/reports/retention/export",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();

    const atRiskCutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const [enrolled, lost, atRisk, monthlyEnrolled, monthlyLost] = await Promise.all([
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"))),
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "lost"))),
      db.select({ cnt: count() }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"), lte(contactsTable.updatedAt, atRiskCutoff))),
      db.select({ ym: sql<string>`TO_CHAR(${contactsTable.createdAt}, 'YYYY-MM')`, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "enrolled"), gte(contactsTable.createdAt, new Date(now.getFullYear() - 1, now.getMonth(), 1))))
        .groupBy(sql`TO_CHAR(${contactsTable.createdAt}, 'YYYY-MM')`),
      db.select({ ym: sql<string>`TO_CHAR(${contactsTable.updatedAt}, 'YYYY-MM')`, cnt: count() })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, authReq.orgId), eq(contactsTable.status, "lost"), gte(contactsTable.updatedAt, new Date(now.getFullYear() - 1, now.getMonth(), 1))))
        .groupBy(sql`TO_CHAR(${contactsTable.updatedAt}, 'YYYY-MM')`),
    ]);

    const enrolledN = Number(enrolled[0]?.cnt ?? 0);
    const lostN = Number(lost[0]?.cnt ?? 0);
    const atRiskN = Number(atRisk[0]?.cnt ?? 0);
    const retentionRate = (enrolledN + lostN) > 0 ? Math.round((enrolledN / (enrolledN + lostN)) * 1000) / 10 : 0;

    const trendMap: Record<string, { enrolled: number; lost: number }> = {};
    for (const r of monthlyEnrolled) { trendMap[r.ym] ??= { enrolled: 0, lost: 0 }; trendMap[r.ym].enrolled = Number(r.cnt); }
    for (const r of monthlyLost) { trendMap[r.ym] ??= { enrolled: 0, lost: 0 }; trendMap[r.ym].lost = Number(r.cnt); }

    const summarySection = [
      ["Metric", "Value"],
      ["Enrolled Members", enrolledN],
      ["Lost Members", lostN],
      ["At-Risk Members", atRiskN],
      ["Retention Rate", retentionRate + "%"],
      [],
      ["Month", "Enrolled", "Lost"],
      ...Object.entries(trendMap).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => [m, v.enrolled, v.lost]),
    ];

    const csv = summarySection.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "retention_csv", {}, Object.keys(trendMap).length + 4);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="retention-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

export default router;
