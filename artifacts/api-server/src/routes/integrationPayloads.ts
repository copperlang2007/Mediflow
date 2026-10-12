/**
 * Full integration records: every value an integration (EnrollHere) sent for
 * a call, as received.
 *
 *   GET /integration-payloads/:id
 *
 * Limited to PHI_PRIVILEGED_ROLES (super admin, agency admin, compliance
 * manager) with a second factor, and to a live contact in the caller's org.
 * Like the full application view it writes an audit_log entry on EVERY view,
 * before any data is returned: no audit row, no data.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, auditLogTable, contactsTable, integrationPayloadsTable, decryptPii } from "@workspace/db";
import { requireMfa } from "../middlewares/requireMfa";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { PHI_PRIVILEGED_ROLES } from "../lib/permissions";

const router: IRouter = Router();

const param = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? ""));

router.get(
  "/integration-payloads/:id",
  requireAuth,
  requireMfa,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!PHI_PRIVILEGED_ROLES.has(authReq.userRole)) {
      res.status(403).json({ error: "Only admins and compliance managers can open the full record." });
      return;
    }
    const id = param(req.params.id);
    const [row] = await db
      .select({ p: integrationPayloadsTable })
      .from(integrationPayloadsTable)
      .innerJoin(contactsTable, and(
        eq(contactsTable.id, integrationPayloadsTable.contactId),
        eq(contactsTable.orgId, authReq.orgId),
        isNull(contactsTable.deletedAt),
      ))
      .where(and(eq(integrationPayloadsTable.id, id), eq(integrationPayloadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    // Decrypt before auditing so a failed decrypt (nothing disclosed) leaves no view record.
    const payload = JSON.parse(decryptPii(row.p.payloadEncrypted)) as Record<string, unknown>;
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "view_integration_payload",
      resourceType: "integration_payload",
      resourceId: id,
      changes: { source: row.p.source, contactId: row.p.contactId },
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] || null,
    });
    res.set("Cache-Control", "no-store");
    res.json({
      id: row.p.id,
      source: row.p.source,
      eventType: row.p.eventType,
      receivedAt: row.p.receivedAt,
      contactId: row.p.contactId,
      payload,
    });
  },
);

export default router;
