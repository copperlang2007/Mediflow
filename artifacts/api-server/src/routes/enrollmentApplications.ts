/**
 * Full enrollment applications (EnrollHere / Sunfire).
 *
 *   GET /contacts/:id/applications      — summary list (no PHI beyond plan info)
 *   GET /applications/:id/full          — the decrypted application
 *
 * The full view is limited to PHI_PRIVILEGED_ROLES and to the agent who
 * services the client (the contact's assigned agent, or the application's
 * writing agent; see lib/phiAccess.ts). It writes an audit_log entry on EVERY
 * view, before any data is returned: if the audit write fails, nothing is
 * shown. Health answers and race/ethnicity are only ever returned here, to a
 * person allowed to look at them, never to routing, scoring or AI features.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  auditLogTable,
  contactsTable,
  enrollmentsTable,
  enrollmentApplicationsTable,
  enrollmentApplicationVersionsTable,
  decryptPii,
} from "@workspace/db";
import { requireMfa } from "../middlewares/requireMfa";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { PHI_PRIVILEGED_ROLES } from "../lib/permissions";
import { applicationAccessColumns, mayViewFullApplication, phiViewerAgent } from "../lib/phiAccess";
import { isPolicyEvent, parsePolicyEvent } from "../lib/integrations/enrollhere/policyEvent";

const router: IRouter = Router();

/**
 * Medicare / Medicaid numbers from a Sunfire application read from GHL custom
 * fields (lib/integrations/ghl/sunfire.ts stores them as "Label (merge_key)").
 */
function sunfireFieldIds(payload: Record<string, unknown>): { medicareNumber: string | null; medicaidNumber: string | null } | null {
  if (payload.source !== "gohighlevel" || typeof payload.fields !== "object" || payload.fields === null) return null;
  const fields = payload.fields as Record<string, unknown>;
  // A number is shown only when every field carrying it (the key and its
  // aliases) agrees: a renamed, duplicated or spouse field that differs means
  // showing none rather than risk another person's number at the top. The
  // full field list below still shows each one with its label.
  const pick = (...keys: string[]): string | null => {
    const values = new Set<string>();
    for (const [label, v] of Object.entries(fields)) {
      if (typeof v !== "string" || !v.trim()) continue;
      if (keys.some((key) => label.endsWith(`(${key})`))) values.add(v.trim().toUpperCase().replace(/[\s-]/g, ""));
    }
    return values.size === 1 ? [...values][0]! : null;
  };
  return { medicareNumber: pick("medicare_number", "applicanthicn"), medicaidNumber: pick("medicaid_number") };
}

const FULL_VIEW_REFUSED = "Only admins, compliance and the client's own agent can view full applications.";


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
    const rows = await db.select({ row: summaryColumns, access: applicationAccessColumns }).from(enrollmentApplicationsTable)
      .innerJoin(contactsTable, eq(contactsTable.id, enrollmentApplicationsTable.contactId))
      .leftJoin(enrollmentsTable, eq(enrollmentsTable.id, enrollmentApplicationsTable.enrollmentId))
      .where(and(eq(enrollmentApplicationsTable.orgId, authReq.orgId), eq(enrollmentApplicationsTable.contactId, contactId)))
      .orderBy(desc(enrollmentApplicationsTable.updatedAt));
    const viewer = await phiViewerAgent(authReq);
    const applications = rows.map(({ row, access }) => ({
      ...row,
      canViewFull: mayViewFullApplication(authReq.userRole, viewer, access),
    }));
    res.json({ applications, canViewFull: applications.some((a) => a.canViewFull) });
  },
);

router.get(
  "/applications/:id/full",
  requireAuth,
  // Privileged roles must have a second factor to decrypt a full application.
  requireMfa,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const viewer = await phiViewerAgent(authReq);
    if (!PHI_PRIVILEGED_ROLES.has(authReq.userRole) && !viewer) {
      res.status(403).json({ error: FULL_VIEW_REFUSED });
      return;
    }
    const id = param(req.params.id);
    // Only for a live contact in this org: a deleted contact's application is
    // not viewable (hard deletes cascade the application away entirely).
    const [found] = await db.select({
      app: enrollmentApplicationsTable,
      access: applicationAccessColumns,
    }).from(enrollmentApplicationsTable)
      .innerJoin(contactsTable, and(
        eq(contactsTable.id, enrollmentApplicationsTable.contactId),
        eq(contactsTable.orgId, authReq.orgId),
        isNull(contactsTable.deletedAt),
      ))
      .leftJoin(enrollmentsTable, eq(enrollmentsTable.id, enrollmentApplicationsTable.enrollmentId))
      .where(and(eq(enrollmentApplicationsTable.id, id), eq(enrollmentApplicationsTable.orgId, authReq.orgId))).limit(1);
    const app = found?.app;
    const privileged = PHI_PRIVILEGED_ROLES.has(authReq.userRole);
    // An agent gets the same 403 for "not yours" and "no such application",
    // so application ids can't be probed.
    if (!app || !mayViewFullApplication(authReq.userRole, viewer, found.access)) {
      if (!privileged) { res.status(403).json({ error: FULL_VIEW_REFUSED }); return; }
      res.status(404).json({ error: "Application not found" });
      return;
    }

    const requested = Number(req.query.version);
    const version = Number.isInteger(requested) && requested > 0 ? requested : app.currentVersion;
    const [row] = await db.select().from(enrollmentApplicationVersionsTable)
      .where(and(eq(enrollmentApplicationVersionsTable.applicationId, id), eq(enrollmentApplicationVersionsTable.version, version))).limit(1);
    if (!row) { res.status(404).json({ error: "Version not found" }); return; }

    // Decrypt before auditing so a failed decrypt (nothing disclosed) leaves
    // no view record; the audit row is still written before any data is sent.
    const payload = JSON.parse(decryptPii(row.payloadEncrypted)) as Record<string, unknown>;

    // No audit row, no data.
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "view_full_application",
      resourceType: "enrollment_application",
      resourceId: id,
      changes: { version, contactId: app.contactId },
      ipAddress: req.ip ?? null, // the client address (trust proxy), not the whole forwarding chain
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
    const ids = isPolicyEvent(payload) ? parsePolicyEvent(payload) : sunfireFieldIds(payload);

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
