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
  decryptMedicareId,
  decryptPii,
} from "@workspace/db";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { PHI_PRIVILEGED_ROLES } from "../lib/permissions";

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
    const [app] = await db.select().from(enrollmentApplicationsTable)
      .where(and(eq(enrollmentApplicationsTable.id, id), eq(enrollmentApplicationsTable.orgId, authReq.orgId))).limit(1);
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
      medicareId: app.medicareIdEncrypted ? decryptMedicareId(app.medicareIdEncrypted) : null,
      medicaidNumber: app.medicaidNumberEncrypted ? decryptPii(app.medicaidNumberEncrypted) : null,
      payload: JSON.parse(decryptPii(row.payloadEncrypted)),
    });
  },
);

export default router;
