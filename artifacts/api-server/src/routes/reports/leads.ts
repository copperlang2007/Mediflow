import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  db,
  contactsTable,
  leadsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
  requireExportConfirm,
} from "../../middlewares/requireAuth";
import { parseRange, logExport } from "./shared";

const router: IRouter = Router();

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

// ─── Leads CSV Export ─────────────────────────────────────────────────────────
router.get(
  "/reports/leads/export",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const allLeads = await db
      .select({ source: leadsTable.source, status: leadsTable.status })
      .from(leadsTable)
      .where(and(eq(leadsTable.orgId, authReq.orgId), gte(leadsTable.createdAt, start), lte(leadsTable.createdAt, end)));

    type SourceRow = { source: string; total: number; converted: number; enrolled: number };
    const sourceMap: Record<string, SourceRow> = {};
    for (const l of allLeads) {
      const src = l.source ?? "unknown";
      if (!sourceMap[src]) sourceMap[src] = { source: src, total: 0, converted: 0, enrolled: 0 };
      sourceMap[src].total++;
      if (l.status === "converted") { sourceMap[src].converted++; sourceMap[src].enrolled++; }
    }

    const rows = Object.values(sourceMap).map((r) => [
      r.source,
      r.total,
      r.converted,
      r.total > 0 ? Math.round((r.converted / r.total) * 100) + "%" : "0%",
      r.enrolled,
    ]);

    const header = ["Source", "Total Leads", "Converted", "Conversion Rate", "Enrolled"];
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "leads_csv", { startDate: start, endDate: end }, rows.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="leads-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

export default router;
