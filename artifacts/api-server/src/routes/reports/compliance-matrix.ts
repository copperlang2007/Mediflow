import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  ahipRecordsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
  requireExportConfirm,
} from "../../middlewares/requireAuth";
import { logExport } from "./shared";

const router: IRouter = Router();

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

    // Bucket licenses by agent once — avoids O(agents × licenses) .filter scan.
    const licensesByAgent = new Map<string, typeof licenses>();
    for (const l of licenses) {
      const aid = l.state_licenses.agentId;
      const arr = licensesByAgent.get(aid);
      if (arr) arr.push(l); else licensesByAgent.set(aid, [l]);
    }
    const licenseMatrix = agents.map((agent) => {
      const agentLicenses = licensesByAgent.get(agent.id) ?? [];
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

    // Bucket certs by carrier once — avoids O(carriers × certs) .filter scan.
    const certsByCarrier = new Map<string, typeof certs>();
    for (const c of certs) {
      const arr = certsByCarrier.get(c.carrierId);
      if (arr) arr.push(c); else certsByCarrier.set(c.carrierId, [c]);
    }
    const carrierCertCompletion = carriers.map((carrier) => {
      const carrierCerts = certsByCarrier.get(carrier.id) ?? [];
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

// ─── Compliance Matrix CSV Export ─────────────────────────────────────────────
router.get(
  "/reports/compliance-matrix/export",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const agents = await db.select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName })
      .from(agentsTable).where(eq(agentsTable.orgId, authReq.orgId));

    const agentIds = agents.map((a) => a.id);
    if (!agentIds.length) { res.setHeader("Content-Type", "text/csv"); res.send(""); return; }

    const agentNameMap: Record<string, string> = {};
    for (const a of agents) agentNameMap[a.id] = `${a.firstName} ${a.lastName}`;

    const [licenses, ahipRecords] = await Promise.all([
      db.select({
        agentId: stateLicensesTable.agentId,
        stateCode: stateLicensesTable.stateCode,
        licenseType: stateLicensesTable.licenseType,
        status: stateLicensesTable.status,
        expiryDate: stateLicensesTable.expiryDate,
      }).from(stateLicensesTable).where(inArray(stateLicensesTable.agentId, agentIds)),

      db.select({ agentId: ahipRecordsTable.agentId, year: ahipRecordsTable.certificationYear, status: ahipRecordsTable.status })
        .from(ahipRecordsTable).where(inArray(ahipRecordsTable.agentId, agentIds)),
    ]);

    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const licenseRows = licenses.map((l) => [
      agentNameMap[l.agentId] ?? l.agentId,
      l.stateCode,
      l.licenseType,
      l.status,
      l.expiryDate ? new Date(l.expiryDate).toISOString().slice(0, 10) : "",
      l.expiryDate && new Date(l.expiryDate) <= in90 && new Date(l.expiryDate) >= now ? "YES" : "no",
    ]);

    const ahipRows = ahipRecords.map((r) => [
      agentNameMap[r.agentId] ?? r.agentId,
      "AHIP",
      "certification",
      r.status,
      String(r.year),
      "",
    ]);

    const header = ["Agent", "State/Code", "Type", "Status", "Expiry Date", "Expiring in 90 Days"];
    const csv = [header, ...licenseRows, ...ahipRows].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "compliance_matrix_csv", {}, licenseRows.length + ahipRows.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="compliance-matrix-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

export default router;
