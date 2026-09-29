/**
 * An agent's own clients ("My clients").
 *
 *   GET /agents/me/clients        — the caller's clients: contacts assigned to
 *                                   their agent profile, or with an enrollment
 *                                   they wrote. Search + paging.
 *   GET /agents/me/clients/:id    — one of those clients, with PHI (date of
 *                                   birth, Medicare ID, health conditions),
 *                                   their policies and enrollment applications.
 *
 * Agents have no `contact:read` (the agency-wide CRM stays with back-office
 * roles); these routes are for the `agent` role, resolve the agent from the
 * session (agentsTable.userId + orgId) and only ever return that agent's
 * clients: assigned to them, or holding a still-pending/active policy they
 * wrote (lib/phiAccess.ts). The servicing agent needs the health answers to
 * find the plans a client qualifies for, so PHI is unmasked for exactly those
 * clients; the full application view (routes/enrollmentApplications.ts) stays
 * audited on every open.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  carriersTable,
  contactsTable,
  enrollmentApplicationsTable,
  enrollmentsTable,
} from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { applicationAccessColumns, mayViewFullApplication, phiViewerAgent, servicedByAgent } from "../lib/phiAccess";
import { serializeContact } from "../lib/serializeContact";

const router: IRouter = Router();

const NO_AGENT = "My clients is for agents: no agent record is linked to your account.";

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

router.get(
  "/agents/me/clients",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const viewer = await phiViewerAgent(authReq);
    const agentId = viewer?.id;
    if (!viewer || !agentId) { res.status(404).json({ error: NO_AGENT }); return; }

    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    const conditions: SQL[] = [eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt), servicedByAgent(agentId)];
    if (search) {
      const q = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(or(
        ilike(contactsTable.firstName, q),
        ilike(contactsTable.lastName, q),
        ilike(contactsTable.email, q),
        ilike(contactsTable.phone, q),
      )!);
    }

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db.select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        email: contactsTable.email,
        phone: contactsTable.phone,
        city: contactsTable.city,
        stateCode: contactsTable.stateCode,
        status: contactsTable.status,
        currentPlanType: contactsTable.currentPlanType,
        dob: contactsTable.dob,
      }).from(contactsTable).where(and(...conditions))
        .orderBy(asc(contactsTable.lastName), asc(contactsTable.firstName), asc(contactsTable.id))
        .limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)` }).from(contactsTable).where(and(...conditions)),
    ]);
    // The list carries what finding a client needs; the Medicare ID and health
    // conditions are only in the detail.
    res.set("Cache-Control", "no-store");
    res.json({ data: rows, total: Number(total) });
  },
);

router.get(
  "/agents/me/clients/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const viewer = await phiViewerAgent(authReq);
    const agentId = viewer?.id;
    if (!viewer || !agentId) { res.status(404).json({ error: NO_AGENT }); return; }
    const id = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);

    const [contact] = await db.select().from(contactsTable)
      .where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt), servicedByAgent(agentId)))
      .limit(1);
    // Not one of this agent's clients looks the same as no such client.
    if (!contact) { res.status(404).json({ error: "Client not found" }); return; }

    const [policies, applications] = await Promise.all([
      db.select({
        id: enrollmentsTable.id,
        carrierName: carriersTable.name,
        planName: enrollmentsTable.planName,
        planId: enrollmentsTable.planId,
        planType: enrollmentsTable.planType,
        planYear: enrollmentsTable.planYear,
        policyNumber: enrollmentsTable.policyNumber,
        applicationDate: enrollmentsTable.applicationDate,
        effectiveDate: enrollmentsTable.effectiveDate,
        status: enrollmentsTable.status,
        effectuated: enrollmentsTable.effectuated,
        writtenByMe: sql<boolean>`${enrollmentsTable.agentId} = ${agentId}`,
      }).from(enrollmentsTable)
        .leftJoin(carriersTable, eq(carriersTable.id, enrollmentsTable.carrierId))
        .where(and(eq(enrollmentsTable.orgId, authReq.orgId), eq(enrollmentsTable.contactId, contact.id)))
        .orderBy(desc(enrollmentsTable.planYear), desc(enrollmentsTable.effectiveDate)),
      db.select({ app: {
        id: enrollmentApplicationsTable.id,
        source: enrollmentApplicationsTable.source,
        confirmationCode: enrollmentApplicationsTable.confirmationCode,
        currentVersion: enrollmentApplicationsTable.currentVersion,
        carrierName: enrollmentApplicationsTable.carrierName,
        planName: enrollmentApplicationsTable.planName,
        planType: enrollmentApplicationsTable.planType,
        snpType: enrollmentApplicationsTable.snpType,
        policyStatus: enrollmentApplicationsTable.policyStatus,
        effectiveDate: enrollmentApplicationsTable.effectiveDate,
        signatureDate: enrollmentApplicationsTable.signatureDate,
        agentEmail: enrollmentApplicationsTable.agentEmail,
        updatedAt: enrollmentApplicationsTable.updatedAt,
      }, access: applicationAccessColumns }).from(enrollmentApplicationsTable)
        .innerJoin(contactsTable, eq(contactsTable.id, enrollmentApplicationsTable.contactId))
        .leftJoin(enrollmentsTable, eq(enrollmentsTable.id, enrollmentApplicationsTable.enrollmentId))
        .where(and(eq(enrollmentApplicationsTable.orgId, authReq.orgId), eq(enrollmentApplicationsTable.contactId, contact.id)))
        .orderBy(desc(enrollmentApplicationsTable.updatedAt)),
    ]);

    res.set("Cache-Control", "no-store");
    res.json({
      contact: serializeContact(contact, authReq.userRole, true),
      policies,
      applications: applications.map(({ app, access }) => ({
        ...app,
        canViewFull: mayViewFullApplication(authReq.userRole, viewer, access),
      })),
    });
  },
);

export default router;
