import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, gt, lte, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  renewalSnoozesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

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

export default router;
