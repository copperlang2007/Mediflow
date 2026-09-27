/**
 * Full enrollment applications (EnrollHere / Sunfire).
 *
 *   GET /contacts/:id/applications      — summary list (no PHI beyond plan info)
 *   GET /applications/:id/full          — the decrypted application
 *
 * The full view is limited to PHI_PRIVILEGED_ROLES and writes an audit_log
 * entry on EVERY view, before any data is returned: if the audit write fails,
 * nothing is shown. Health answers and race/ethnicity are only ever returned
 * here, to a privileged person looking at them, never to routing, scoring or
 * AI features.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  auditLogTable,
  contactsTable,
  enrollmentApplicationsTable,
  enrollmentApplicationVersionsTable,
  decryptPii,
} from "@workspace/db";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { PHI_PRIVILEGED_ROLES } from "../lib/permissions";
import { isPolicyEvent, parsePolicyEvent } from "../lib/integrations/enrollhere/policyEvent";

const router: IRouter = Router();

const param = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");

const summaryColumns = {
  id: enrollmentApplicationsTable.id,
  source: enrollmentApplicationsTable.source,
  confirmationCode: enrollmentApplicationsTable.confirmationCode,
  currentVersion: enrollmentApplicationsTable.currentVersion,
  lastEventType: enrollmentApplicationsTable.lastEventType,
  carrierName: enrollmentApplicationsTable.carrierName,
  planId: enrollmentApplicationsTable.planId,
  planName: enrollmentApplicationsTable.planName,
  planType: enrollmentApplicationsTable.planType,
  snpType: enrollmentApplicationsTable.snpType,
  policyStatus: enrollmentApplicationsTable.policyStatus,
  effectiveDate: enrollmentApplicationsTable.effectiveDate,
  signatureDate: enrollmentApplicationsTable.signatureDate,
  agentEmail: enrollmentApplicationsTable.agentEmail,
  enrollmentId: enrollmentApplicationsTable.enrollmentId,
  updatedAt: enrollmentApplicationsTable.updatedAt,
};

router.get(
  "/contacts/:id/applications",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const contactId = param(req.params.id);
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const rows = await db.select(summaryColumns).from(enrollmentApplicationsTable)
      .where(and(eq(enrollmentApplicationsTable.orgId, authReq.orgId), eq(enrollmentApplicationsTable.contactId, contactId)))
      .orderBy(desc(enrollmentApplicationsTable.updatedAt));
    res.json({ applications: rows, canViewFull: PHI_PRIVILEGED_ROLES.has(authReq.userRole) });
  },
);

router.get(
  "/applications/:id/full",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!PHI_PRIVILEGED_ROLES.has(authReq.userRole)) {
      res.status(403).json({ error: "Only admins and compliance can view full applications." });
      return;
    }
    const id = param(req.params.id);
    // Only for a live contact in this org: a deleted contact's application is
    // not viewable (hard deletes cascade the application away entirely).
    const [found] = await db.select({ app: enrollmentApplicationsTable }).from(enrollmentApplicationsTable)
      .innerJoin(contactsTable, and(
        eq(contactsTable.id, enrollmentApplicationsTable.contactId),
        eq(contactsTable.orgId, authReq.orgId),
        isNull(contactsTable.deletedAt),
      ))
      .where(and(eq(enrollmentApplicationsTable.id, id), eq(enrollmentApplicationsTable.orgId, authReq.orgId))).limit(1);
    const app = found?.app;
    if (!app) { res.status(404).json({ error: "Application not found" }); return; }

    const requested = Number(req.query.version);
    const version = Number.isInteger(requested) && requested > 0 ? requested : app.currentVersion;
    const [row] = await db.select().from(enrollmentApplicationVersionsTable)
      .where(and(eq(enrollmentApplicationVersionsTable.applicationId, id), eq(enrollmentApplicationVersionsTable.version, version))).limit(1);
    if (!row) { res.status(404).json({ error: "Version not found" }); return; }

    // Audit first. No audit row, no data.
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "view_full_application",
      resourceType: "enrollment_application",
      resourceId: id,
      changes: { version, contactId: app.contactId },
      ipAddress: (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null,
    });

    const versions = await db.select({
      version: enrollmentApplicationVersionsTable.version,
      eventType: enrollmentApplicationVersionsTable.eventType,
      receivedAt: enrollmentApplicationVersionsTable.receivedAt,
    }).from(enrollmentApplicationVersionsTable)
      .where(eq(enrollmentApplicationVersionsTable.applicationId, id))
      .orderBy(desc(enrollmentApplicationVersionsTable.version));

    // Identifiers come from the selected version's own payload, so an older
    // version shows the numbers it was received with, not today's.
    const payload = JSON.parse(decryptPii(row.payloadEncrypted)) as Record<string, unknown>;
    const ids = isPolicyEvent(payload) ? parsePolicyEvent(payload) : null;

    res.set("Cache-Control", "no-store");
    res.json({
      application: {
        id: app.id,
        confirmationCode: app.confirmationCode,
        carrierName: app.carrierName,
        planName: app.planName,
        policyStatus: app.policyStatus,
        effectiveDate: app.effectiveDate,
      },
      version,
      eventType: row.eventType,
      receivedAt: row.receivedAt,
      versions,
      medicareId: ids?.medicareNumber ?? null,
      medicaidNumber: ids?.medicaidNumber ?? null,
      payload,
    });
  },
);

export default router;
