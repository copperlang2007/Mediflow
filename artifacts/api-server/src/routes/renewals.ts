import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, gt, lte, desc, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  renewalSnoozesTable,
  ahipRecordsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { AHIP_REQUIRED_AGENT_STATUSES, isAhipComplete } from "../lib/agents/ahipCoverage";
import { expiredLicenseWhere } from "../lib/licenses/licenseStatus";
import { sellingPlanYear } from "../lib/compliance/planYear";

const router: IRouter = Router();

router.get(
  "/renewals",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const daysAhead = Math.min(parseInt((req.query.days as string) ?? "90", 10) || 90, 365);
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    // Fetch all active snoozes for this org so we can filter them out
    const activeSnoozesRows = await db
      .select({ resourceType: renewalSnoozesTable.resourceType, resourceId: renewalSnoozesTable.resourceId })
      .from(renewalSnoozesTable)
      .where(
        and(
          eq(renewalSnoozesTable.orgId, authReq.orgId),
          gt(renewalSnoozesTable.snoozedUntil, now),
        ),
      );
    const snoozed = new Set(activeSnoozesRows.map((s) => `${s.resourceType}:${s.resourceId}`));

    const [expiringLicenses, expiringCerts] = await Promise.all([
      db
        .select({
          id: stateLicensesTable.id,
          agentId: stateLicensesTable.agentId,
          agentName: sql<string>`concat(${agentsTable.firstName}, ' ', ${agentsTable.lastName})`,
          type: sql<string>`'license'`,
          detail: sql<string>`concat(${stateLicensesTable.stateCode}, ' ', ${stateLicensesTable.licenseType})`,
          expiryDate: stateLicensesTable.expiryDate,
          status: stateLicensesTable.status,
        })
        .from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            gt(stateLicensesTable.expiryDate, now),
            lte(stateLicensesTable.expiryDate, cutoff),
            eq(stateLicensesTable.status, "active"),
          ),
        )
        .orderBy(stateLicensesTable.expiryDate),

      db
        .select({
          id: carrierCertificationsTable.id,
          agentId: carrierCertificationsTable.agentId,
          agentName: sql<string>`concat(${agentsTable.firstName}, ' ', ${agentsTable.lastName})`,
          type: sql<string>`'certification'`,
          detail: carriersTable.name,
          expiryDate: carrierCertificationsTable.expiryDate,
          status: carrierCertificationsTable.status,
        })
        .from(carrierCertificationsTable)
        .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .innerJoin(carriersTable, eq(carrierCertificationsTable.carrierId, carriersTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            gt(carrierCertificationsTable.expiryDate, now),
            lte(carrierCertificationsTable.expiryDate, cutoff),
            eq(carrierCertificationsTable.status, "passed"),
          ),
        )
        .orderBy(carrierCertificationsTable.expiryDate),
    ]);

    const allRenewals = [...expiringLicenses, ...expiringCerts]
      .filter((r) => r.expiryDate != null)
      .filter((r) => !snoozed.has(`${r.type}:${r.id}`))
      .map((r) => {
        const expiryMs = r.expiryDate!.getTime();
        const daysUntilExpiry = Math.ceil((expiryMs - now.getTime()) / (1000 * 60 * 60 * 24));
        const urgency: "critical" | "warning" | "notice" =
          daysUntilExpiry <= 30 ? "critical" : daysUntilExpiry <= 60 ? "warning" : "notice";
        return { ...r, daysUntilExpiry, urgency };
      })
      .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

    res.json({ renewals: allRenewals, total: allRenewals.length, daysAhead });
  },
);

router.post(
  "/renewals/:resourceType/:id/snooze",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { resourceType, id } = req.params;
    const rawType = Array.isArray(resourceType) ? resourceType[0] : resourceType;
    const rawId = Array.isArray(id) ? id[0] : id;
    const days = Math.max(1, Math.min(365, parseInt((req.body?.days as string) ?? "30", 10) || 30));

    if (!["license", "certification"].includes(rawType)) {
      res.status(400).json({ error: "resourceType must be 'license' or 'certification'" });
      return;
    }

    // Verify the resource exists and belongs to the caller's org
    if (rawType === "license") {
      const [lic] = await db
        .select({ id: stateLicensesTable.id })
        .from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(and(eq(stateLicensesTable.id, rawId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!lic) { res.status(404).json({ error: "License not found" }); return; }
    } else {
      const [cert] = await db
        .select({ id: carrierCertificationsTable.id })
        .from(carrierCertificationsTable)
        .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .where(and(eq(carrierCertificationsTable.id, rawId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!cert) { res.status(404).json({ error: "Certification not found" }); return; }
    }

    const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await db
      .insert(renewalSnoozesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        resourceType: rawType,
        resourceId: rawId,
        snoozedUntil,
        createdBy: authReq.userId,
      });

    res.json({ snoozedUntil, days, resourceType: rawType, resourceId: rawId });
  },
);

router.post(
  "/renewals/:resourceType/:id/resolve",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { resourceType, id } = req.params;
    const rawType = Array.isArray(resourceType) ? resourceType[0] : resourceType;
    const rawId = Array.isArray(id) ? id[0] : id;

    if (!["license", "certification"].includes(rawType)) {
      res.status(400).json({ error: "resourceType must be 'license' or 'certification'" });
      return;
    }

    // Verify the resource exists and belongs to the caller's org
    if (rawType === "license") {
      const [lic] = await db
        .select({ id: stateLicensesTable.id })
        .from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(and(eq(stateLicensesTable.id, rawId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!lic) { res.status(404).json({ error: "License not found" }); return; }
    } else {
      const [cert] = await db
        .select({ id: carrierCertificationsTable.id })
        .from(carrierCertificationsTable)
        .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .where(and(eq(carrierCertificationsTable.id, rawId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!cert) { res.status(404).json({ error: "Certification not found" }); return; }
    }

    // Resolve = snooze for 1 year (effectively dismiss until next renewal cycle)
    const snoozedUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    await db
      .insert(renewalSnoozesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        resourceType: rawType,
        resourceId: rawId,
        snoozedUntil,
        createdBy: authReq.userId,
      });

    res.json({ resolved: true, resourceType: rawType, resourceId: rawId });
  },
);

// GET /compliance-alerts — agency-wide compliance dashboard rollup
//
// Surfaces compliance gaps that complement the renewals list (which only
// covers items with an explicit expiry date). Specifically it reports:
//   - Total counts of expiring licenses & certs by urgency (≤30, ≤60, ≤90 days)
//   - AHIP status for the current cert year: passed / in-progress / missing
//   - Per-agent rollup of how many alerts each agent has (top 10)
router.get(
  "/compliance-alerts",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86_400_000);
    const in60 = new Date(now.getTime() + 60 * 86_400_000);
    const in90 = new Date(now.getTime() + 90 * 86_400_000);
    const currentYear = now.getFullYear();
    // AHIP is scored against the plan year being sold (planYear.ts), the same
    // year the dashboard and the Ready-to-Sell gate use. That is next year from
    // Oct 1, so it is NOT always the calendar year.
    const certYear = sellingPlanYear(now);
    const ahipDeadline = new Date(`${currentYear}-10-01T00:00:00Z`);
    const daysUntilAhipDeadline = Math.ceil(
      (ahipDeadline.getTime() - now.getTime()) / 86_400_000,
    );

    const [licRows, certRows, agentsActive, ahipRecords, expiredLicRows] = await Promise.all([
      db
        .select({
          id: stateLicensesTable.id,
          agentId: stateLicensesTable.agentId,
          firstName: agentsTable.firstName,
          lastName: agentsTable.lastName,
          expiryDate: stateLicensesTable.expiryDate,
        })
        .from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            gt(stateLicensesTable.expiryDate, now),
            lte(stateLicensesTable.expiryDate, in90),
            eq(stateLicensesTable.status, "active"),
          ),
        ),
      db
        .select({
          id: carrierCertificationsTable.id,
          agentId: carrierCertificationsTable.agentId,
          firstName: agentsTable.firstName,
          lastName: agentsTable.lastName,
          expiryDate: carrierCertificationsTable.expiryDate,
        })
        .from(carrierCertificationsTable)
        .innerJoin(agentsTable, eq(carrierCertificationsTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            gt(carrierCertificationsTable.expiryDate, now),
            lte(carrierCertificationsTable.expiryDate, in90),
            eq(carrierCertificationsTable.status, "passed"),
          ),
        ),
      db
        .select({
          id: agentsTable.id,
          firstName: agentsTable.firstName,
          lastName: agentsTable.lastName,
        })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            // Shared with Certifications / dashboard (lib/agents/ahipCoverage.ts).
            inArray(agentsTable.status, [...AHIP_REQUIRED_AGENT_STATUSES]),
          ),
        ),
      db
        .select({
          agentId: ahipRecordsTable.agentId,
          status: ahipRecordsTable.status,
        })
        .from(ahipRecordsTable)
        .innerJoin(agentsTable, eq(ahipRecordsTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            eq(ahipRecordsTable.certificationYear, certYear),
          ),
        ),
      // Licenses already past their expiry (shared definition), for agents
      // still on the team. These never appear in the "expiring" buckets, so
      // without this count a fully-expired agency read as "none expiring".
      db
        .select({
          agentId: stateLicensesTable.agentId,
          firstName: agentsTable.firstName,
          lastName: agentsTable.lastName,
        })
        .from(stateLicensesTable)
        .innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id))
        .where(
          and(
            eq(agentsTable.orgId, authReq.orgId),
            inArray(agentsTable.status, [...AHIP_REQUIRED_AGENT_STATUSES, "suspended"]),
            expiredLicenseWhere(now),
          ),
        ),
    ]);

    type AgentRollup = {
      agentId: string;
      agentName: string;
      licensesExpiring: number;
      licensesExpired: number;
      certsExpiring: number;
      ahipStatus: "passed" | "in_progress" | "not_started" | "missing" | "failed";
      alertCount: number;
    };
    const rollup = new Map<string, AgentRollup>();
    const ensureAgent = (id: string, name: string): AgentRollup => {
      let row = rollup.get(id);
      if (!row) {
        row = {
          agentId: id,
          agentName: name,
          licensesExpiring: 0,
          licensesExpired: 0,
          certsExpiring: 0,
          ahipStatus: "missing",
          alertCount: 0,
        };
        rollup.set(id, row);
      }
      return row;
    };

    const bucketize = (date: Date) => {
      if (date <= in30) return "critical" as const;
      if (date <= in60) return "warning" as const;
      return "notice" as const;
    };

    const licCounts = { critical: 0, warning: 0, notice: 0, expired: expiredLicRows.length };
    for (const r of expiredLicRows) {
      ensureAgent(r.agentId, `${r.firstName} ${r.lastName}`).licensesExpired++;
    }
    for (const r of licRows) {
      if (!r.expiryDate) continue;
      const b = bucketize(r.expiryDate);
      licCounts[b]++;
      const row = ensureAgent(r.agentId, `${r.firstName} ${r.lastName}`);
      row.licensesExpiring++;
    }

    const certCounts = { critical: 0, warning: 0, notice: 0 };
    for (const r of certRows) {
      if (!r.expiryDate) continue;
      const b = bucketize(r.expiryDate);
      certCounts[b]++;
      const row = ensureAgent(r.agentId, `${r.firstName} ${r.lastName}`);
      row.certsExpiring++;
    }

    // Seed rollup with active agents so AHIP-missing rows show up even if the
    // agent has no expiring licenses/certs.
    for (const a of agentsActive) {
      ensureAgent(a.id, `${a.firstName} ${a.lastName}`);
    }

    const ahipByAgent = new Map(ahipRecords.map((r) => [r.agentId, r.status]));
    const ahipCounts = { passed: 0, in_progress: 0, not_started: 0, missing: 0, failed: 0 };

    for (const a of agentsActive) {
      const row = ensureAgent(a.id, `${a.firstName} ${a.lastName}`);
      const status = ahipByAgent.get(a.id);
      // Waived counts as complete, same as the Ready-to-Sell gate.
      if (isAhipComplete(status)) {
        row.ahipStatus = "passed";
        ahipCounts.passed++;
      } else if (status === "in_progress") {
        row.ahipStatus = "in_progress";
        ahipCounts.in_progress++;
      } else if (status === "not_started") {
        row.ahipStatus = "not_started";
        ahipCounts.not_started++;
      } else if (status === "failed") {
        row.ahipStatus = "failed";
        ahipCounts.failed++;
      } else {
        row.ahipStatus = "missing";
        ahipCounts.missing++;
      }
    }

    // alertCount = expiring items + (AHIP not passed)
    for (const row of rollup.values()) {
      row.alertCount =
        row.licensesExpiring +
        row.licensesExpired +
        row.certsExpiring +
        (row.ahipStatus !== "passed" ? 1 : 0);
    }

    const topAgents = Array.from(rollup.values())
      .filter((r) => r.alertCount > 0)
      .sort((a, b) => b.alertCount - a.alertCount)
      .slice(0, 10);

    const totalActiveAgents = agentsActive.length;
    const ahipCompletionRate =
      totalActiveAgents > 0
        ? Math.round((ahipCounts.passed / totalActiveAgents) * 1000) / 10
        : 0;

    res.json({
      generatedAt: now.toISOString(),
      currentCertYear: certYear,
      ahipDeadline: ahipDeadline.toISOString(),
      daysUntilAhipDeadline,
      licenses: licCounts,
      certifications: certCounts,
      ahip: {
        ...ahipCounts,
        totalActiveAgents,
        agentsRequiringAhip: totalActiveAgents,
        completionRate: ahipCompletionRate,
      },
      topAgents,
      agentsWithAlerts: Array.from(rollup.values()).filter((r) => r.alertCount > 0).length,
    });
  },
);

export default router;
