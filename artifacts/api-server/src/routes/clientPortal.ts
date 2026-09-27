/**
 * Client Portal preview (staff-facing).
 *
 *   GET /client-portal/preview/:contactId
 *
 * Composes, read-only, what one member would see in a future self-service
 * portal: their profile, their plans (from `enrollments`), their SMS/email
 * thread, the documents filed against them and the agent they can reach.
 *
 * There is NO member login yet — this endpoint is for signed-in staff only and
 * requires the same `contact:read` permission as the contact-detail page.
 * Because it gathers a member's PHI into one view it is treated like the
 * "Full application" view: an audit_log row is written on EVERY call, before
 * any data is returned. If the audit write fails, nothing is shown.
 *
 * PHI masking is the shared `serializeContact` policy (MBI / DOB / health
 * conditions masked for non-privileged roles); health conditions are not
 * part of the preview at all.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  auditLogTable,
  agentsTable,
  carriersTable,
  contactsTable,
  documentsTable,
  enrollmentsTable,
  messagesTable,
  messageThreadsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { can } from "../lib/permissions";
import { serializeContact } from "../lib/serializeContact";

const router: IRouter = Router();

const param = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

/** How many of the newest messages the preview shows. */
const MESSAGE_LIMIT = 50;
const DOCUMENT_LIMIT = 50;

router.get(
  "/client-portal/preview/:contactId",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const contactId = param(req.params.contactId);
    if (!contactId || contactId.length > 100) {
      res.status(400).json({ error: "Invalid contact id" });
      return;
    }

    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const [plans, messagesDesc, documents, assignedAgent] = await Promise.all([
      db
        .select({
          id: enrollmentsTable.id,
          carrierId: enrollmentsTable.carrierId,
          carrierName: carriersTable.name,
          planId: enrollmentsTable.planId,
          planName: enrollmentsTable.planName,
          planType: enrollmentsTable.planType,
          planYear: enrollmentsTable.planYear,
          effectiveDate: enrollmentsTable.effectiveDate,
          disenrolledDate: enrollmentsTable.disenrolledDate,
          status: enrollmentsTable.status,
          agentId: enrollmentsTable.agentId,
          agentFirstName: agentsTable.firstName,
          agentLastName: agentsTable.lastName,
        })
        .from(enrollmentsTable)
        .leftJoin(
          carriersTable,
          and(
            eq(carriersTable.id, enrollmentsTable.carrierId),
            eq(carriersTable.orgId, authReq.orgId),
          ),
        )
        .leftJoin(
          agentsTable,
          and(
            eq(agentsTable.id, enrollmentsTable.agentId),
            eq(agentsTable.orgId, authReq.orgId),
          ),
        )
        .where(
          and(
            eq(enrollmentsTable.orgId, authReq.orgId),
            eq(enrollmentsTable.contactId, contactId),
          ),
        )
        .orderBy(desc(enrollmentsTable.planYear), desc(enrollmentsTable.effectiveDate)),
      db
        .select({
          id: messagesTable.id,
          channel: messageThreadsTable.channel,
          direction: messagesTable.direction,
          subject: messagesTable.subject,
          body: messagesTable.body,
          status: messagesTable.status,
          sentAt: messagesTable.sentAt,
          createdAt: messagesTable.createdAt,
        })
        .from(messagesTable)
        .innerJoin(
          messageThreadsTable,
          eq(messagesTable.threadId, messageThreadsTable.id),
        )
        .where(
          and(
            eq(messageThreadsTable.contactId, contactId),
            eq(messageThreadsTable.orgId, authReq.orgId),
          ),
        )
        .orderBy(desc(messagesTable.createdAt))
        .limit(MESSAGE_LIMIT),
      db
        .select({
          id: documentsTable.id,
          name: documentsTable.name,
          category: documentsTable.category,
          mimeType: documentsTable.mimeType,
          fileSizeBytes: documentsTable.fileSizeBytes,
          createdAt: documentsTable.createdAt,
        })
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.orgId, authReq.orgId),
            eq(documentsTable.contactId, contactId),
          ),
        )
        .orderBy(desc(documentsTable.createdAt))
        .limit(DOCUMENT_LIMIT),
      contact.assignedAgentId
        ? db
            .select({
              id: agentsTable.id,
              firstName: agentsTable.firstName,
              lastName: agentsTable.lastName,
              email: agentsTable.email,
              phone: agentsTable.phone,
            })
            .from(agentsTable)
            .where(
              and(
                eq(agentsTable.id, contact.assignedAgentId),
                eq(agentsTable.orgId, authReq.orgId),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    // No audit row, no data — same rule as the full-application view.
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action: "view_client_portal_preview",
      resourceType: "contact",
      resourceId: contact.id,
      changes: {
        plans: plans.length,
        messages: messagesDesc.length,
        documents: documents.length,
        ...(authReq.viewOnly
          ? { viewOnly: true, realOrgId: authReq.realOrgId, viewingOrgId: authReq.viewingOrgId }
          : {}),
      },
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] || null,
    });

    const safe = serializeContact(contact, authReq.userRole);
    const canUpdate = can(authReq.userRole, "contact", "update");

    res.set("Cache-Control", "no-store");
    res.json({
      contact: {
        id: safe.id,
        firstName: safe.firstName,
        lastName: safe.lastName,
        email: safe.email,
        phone: safe.phone,
        status: safe.status,
        city: safe.city,
        stateCode: safe.stateCode,
        zipCode: safe.zipCode,
        preferredLanguage: safe.preferredLanguage,
        currentPlanType: safe.currentPlanType,
        optOutSms: safe.optOutSms,
        optOutEmail: safe.optOutEmail,
      },
      plans,
      // Oldest first, like a chat thread.
      messages: [...messagesDesc].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      ),
      documents,
      agent: assignedAgent,
      permissions: {
        canReplySms: canUpdate && !contact.optOutSms && Boolean(contact.phone),
        canReplyEmail: canUpdate && !contact.optOutEmail && Boolean(contact.email),
      },
      asOf: new Date().toISOString(),
    });
  },
);

export default router;
