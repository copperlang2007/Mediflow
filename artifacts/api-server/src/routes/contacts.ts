import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, or, ilike, inArray, sql, desc, asc, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  contactsTable,
  activitiesTable,
  agentsTable,
  messageThreadsTable,
  messagesTable,
  taskInstancesTable,
  sequenceEnrollmentsTable,
  sequencesTable,
  retentionFlagsTable,
  encryptMedicareId,
  hashMedicareId,
  isMedicareIdEncryptionReadEnabled,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router();

// PHI masking — roles that may see full DOB and Medicare ID
const PHI_PRIVILEGED_ROLES = new Set(["super_admin", "agency_admin", "compliance_manager"]);

function maskContact<T extends { dob?: Date | null; medicareId?: string | null; healthConditions?: string[] | null }>(
  contact: T,
  userRole: string,
): T {
  if (PHI_PRIVILEGED_ROLES.has(userRole)) return contact;
  return {
    ...contact,
    dob: null,
    medicareId: contact.medicareId != null ? "***-**-****" : null,
    healthConditions: contact.healthConditions != null ? [] : null,
  };
}

router.use(
  auditMiddleware("contact", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

const CreateContactSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  dob: z.string().optional().nullable(),
  medicareId: z.string().max(50).optional().nullable(),
  currentPlanType: z.enum(["MA", "PDP", "MAPD", "supp", "other"]).optional().nullable(),
  currentCarrierId: z.string().optional().nullable(),
  planYear: z.number().int().optional().nullable(),
  county: z.string().max(100).optional().nullable(),
  stateCode: z.string().max(2).optional().nullable(),
  zipCode: z.string().max(10).optional().nullable(),
  preferredLanguage: z.string().max(50).optional().nullable(),
  pcpName: z.string().max(100).optional().nullable(),
  pcpNpi: z.string().max(20).optional().nullable(),
  healthConditions: z.string().array().optional(),
  leadSource: z.string().max(100).optional().nullable(),
  status: z.enum(["lead", "prospect", "enrolled", "retained", "lost", "do_not_contact"]).optional(),
  tags: z.string().array().optional(),
  assignedAgentId: z.string().optional().nullable(),
});

const UpdateContactSchema = CreateContactSchema.partial();

// GET /contacts
router.get(
  "/contacts",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const {
      search, status, assignedAgentId, planType, tag,
      limit, offset, sortBy, sortDir,
    } = req.query as Record<string, string | undefined>;

    const conditions: SQL[] = [eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt)];

    if (search) {
      const q = `%${search}%`;
      // Medicare ID search behavior depends on the column-level encryption
      // flag (HIPAA-2):
      //   - flag OFF: legacy partial-match ilike on the plaintext column.
      //   - flag ON:  the plaintext column has been retired; we can only
      //     exact-match against the deterministic HMAC hash. Partial /
      //     prefix matching is impossible by design — HMAC destroys order
      //     — and was overkill for MBIs anyway, which are exact
      //     identifiers. Documented as a user-facing change in the PR.
      const searchClauses: SQL[] = [
        ilike(contactsTable.firstName, q) as SQL,
        ilike(contactsTable.lastName, q) as SQL,
        ilike(contactsTable.email, q) as SQL,
        ilike(contactsTable.phone, q) as SQL,
      ];
      if (isMedicareIdEncryptionReadEnabled()) {
        searchClauses.push(
          eq(contactsTable.medicareIdHash, hashMedicareId(search)) as SQL,
        );
      } else {
        searchClauses.push(ilike(contactsTable.medicareId, q) as SQL);
      }
      conditions.push(or(...searchClauses) as SQL);
    }
    if (status && status !== "all") {
      conditions.push(eq(contactsTable.status, status as "lead" | "prospect" | "enrolled" | "retained" | "lost" | "do_not_contact"));
    }
    if (assignedAgentId) {
      conditions.push(eq(contactsTable.assignedAgentId, assignedAgentId));
    }
    if (planType) {
      conditions.push(eq(contactsTable.currentPlanType, planType as "MA" | "PDP" | "MAPD" | "supp" | "other"));
    }
    if (tag) {
      conditions.push(sql`${contactsTable.tags} @> ARRAY[${tag}]::text[]`);
    }

    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);
    const dir = sortDir === "desc" ? desc : asc;
    const orderExpr =
      sortBy === "name" ? [dir(contactsTable.lastName), dir(contactsTable.firstName)] :
      sortBy === "status" ? [dir(contactsTable.status)] :
      sortBy === "createdAt" ? [dir(contactsTable.createdAt)] :
      [desc(contactsTable.createdAt)];

    const [contacts, totalRes] = await Promise.all([
      db.select().from(contactsTable).where(and(...conditions)).orderBy(...orderExpr).limit(limitNum).offset(offsetNum),
      db.select({ count: sql<number>`count(*)` }).from(contactsTable).where(and(...conditions)),
    ]);

    res.json({ data: contacts.map((c) => maskContact(c, authReq.userRole)), total: Number(totalRes[0]?.count ?? 0) });
  },
);

// POST /contacts
router.post(
  "/contacts",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateContactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    // Dual-write the encrypted + hash columns alongside the plaintext for
    // HIPAA-2 (column-level encryption). The plaintext column stays the
    // source of truth until MEDICARE_ID_ENCRYPTION_ENABLED flips on after
    // the backfill script runs.
    const medicareEnc = d.medicareId
      ? encryptMedicareId(d.medicareId)
      : null;
    const [contact] = await db.insert(contactsTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email ?? null,
      phone: d.phone ?? null,
      dob: d.dob ? new Date(d.dob) : null,
      medicareId: d.medicareId ?? null,
      medicareIdEncrypted: medicareEnc?.encrypted ?? null,
      medicareIdHash: medicareEnc?.hash ?? null,
      currentPlanType: d.currentPlanType ?? null,
      currentCarrierId: d.currentCarrierId ?? null,
      planYear: d.planYear ?? null,
      county: d.county ?? null,
      stateCode: d.stateCode ?? null,
      zipCode: d.zipCode ?? null,
      preferredLanguage: d.preferredLanguage ?? null,
      pcpName: d.pcpName ?? null,
      pcpNpi: d.pcpNpi ?? null,
      healthConditions: d.healthConditions ?? [],
      leadSource: d.leadSource ?? null,
      status: d.status ?? "lead",
      tags: d.tags ?? [],
      assignedAgentId: d.assignedAgentId ?? null,
    }).returning();

    void enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId: authReq.orgId,
      trigger: "contact_created",
      resourceType: "contact",
      resourceId: contact.id,
      context: {
        status: contact.status,
        stateCode: contact.stateCode,
        source: contact.leadSource,
        assignedAgentId: contact.assignedAgentId,
      },
    });

    res.status(201).json(maskContact(contact, authReq.userRole));
  },
);

// GET /contacts/:id
router.get(
  "/contacts/:id",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    res.json(maskContact(contact, authReq.userRole));
  },
);

// PATCH /contacts/:id
router.patch(
  "/contacts/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!existing) { res.status(404).json({ error: "Contact not found" }); return; }

    const parsed = UpdateContactSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const d = parsed.data;

    const updates: Record<string, unknown> = {};
    if (d.firstName !== undefined) updates.firstName = d.firstName;
    if (d.lastName !== undefined) updates.lastName = d.lastName;
    if (d.email !== undefined) updates.email = d.email;
    if (d.phone !== undefined) updates.phone = d.phone;
    if (d.dob !== undefined) updates.dob = d.dob ? new Date(d.dob) : null;
    if (d.medicareId !== undefined) {
      // Dual-write for HIPAA-2 column-level encryption.
      updates.medicareId = d.medicareId;
      if (d.medicareId === null || d.medicareId === "") {
        updates.medicareIdEncrypted = null;
        updates.medicareIdHash = null;
      } else {
        const enc = encryptMedicareId(d.medicareId);
        updates.medicareIdEncrypted = enc.encrypted;
        updates.medicareIdHash = enc.hash;
      }
    }
    if (d.currentPlanType !== undefined) updates.currentPlanType = d.currentPlanType;
    if (d.currentCarrierId !== undefined) updates.currentCarrierId = d.currentCarrierId;
    if (d.planYear !== undefined) updates.planYear = d.planYear;
    if (d.county !== undefined) updates.county = d.county;
    if (d.stateCode !== undefined) updates.stateCode = d.stateCode;
    if (d.zipCode !== undefined) updates.zipCode = d.zipCode;
    if (d.preferredLanguage !== undefined) updates.preferredLanguage = d.preferredLanguage;
    if (d.pcpName !== undefined) updates.pcpName = d.pcpName;
    if (d.pcpNpi !== undefined) updates.pcpNpi = d.pcpNpi;
    if (d.healthConditions !== undefined) updates.healthConditions = d.healthConditions;
    if (d.leadSource !== undefined) updates.leadSource = d.leadSource;
    if (d.status !== undefined) updates.status = d.status;
    if (d.tags !== undefined) updates.tags = d.tags;
    if (d.assignedAgentId !== undefined) updates.assignedAgentId = d.assignedAgentId;

    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    const [existingContact] = d.status !== undefined
      ? await db.select({ status: contactsTable.status }).from(contactsTable).where(eq(contactsTable.id, id)).limit(1)
      : [null];

    const [updated] = await db.update(contactsTable).set(updates).where(eq(contactsTable.id, id)).returning();

    if (d.status !== undefined && existingContact && d.status !== existingContact.status) {
      void enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
        orgId: authReq.orgId,
        trigger: "contact_status_changed",
        resourceType: "contact",
        resourceId: id,
        context: { oldStatus: existingContact.status, newStatus: d.status },
      });
    }

    res.json(updated);
  },
);

// DELETE /contacts/:id
router.delete(
  "/contacts/:id",
  requireAuth,
  requirePermission("contact", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!existing) { res.status(404).json({ error: "Contact not found" }); return; }
    await db.update(contactsTable).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(contactsTable.id, id));
    res.status(204).send();
  },
);

// GET /contacts/:id/activities
router.get(
  "/contacts/:id/activities",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const limitNum = safeLimit(req.query.limit, 50, 1000);
    const offsetNum = safeOffset(req.query.offset);
    const activities = await db.select().from(activitiesTable).where(and(eq(activitiesTable.contactId, id), eq(activitiesTable.orgId, authReq.orgId))).orderBy(desc(activitiesTable.createdAt)).limit(limitNum).offset(offsetNum);
    res.json(activities);
  },
);

// POST /contacts/:id/activities (log note, call, etc.)
router.post(
  "/contacts/:id/activities",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const LogActivitySchema = z.object({
      type: z.enum(["note", "call_log", "sms", "email", "status_change", "enrollment", "task_complete", "document_upload", "sequence_enrolled", "sequence_step"]),
      body: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    });
    const parsed = LogActivitySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    const [activity] = await db.insert(activitiesTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      contactId: id,
      type: parsed.data.type,
      body: parsed.data.body ?? null,
      metadata: parsed.data.metadata ?? null,
      createdBy: authReq.userId,
    }).returning();
    res.status(201).json(activity);
  },
);

// POST /contacts/:id/send-sms
router.post(
  "/contacts/:id/send-sms",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    if (!contact.phone) { res.status(400).json({ error: "Contact has no phone number" }); return; }
    if (contact.optOutSms) { res.status(400).json({ error: "Contact has opted out of SMS" }); return; }

    const SendSmsSchema = z.object({ body: z.string().min(1).max(1600), aiAssisted: z.boolean().optional().default(false) });
    const parsed = SendSmsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    // Find or create SMS thread
    let [thread] = await db.select({ id: messageThreadsTable.id }).from(messageThreadsTable).where(and(eq(messageThreadsTable.contactId, id), eq(messageThreadsTable.channel, "sms"), eq(messageThreadsTable.orgId, authReq.orgId))).limit(1);
    if (!thread) {
      const [newThread] = await db.insert(messageThreadsTable).values({ id: randomUUID(), orgId: authReq.orgId, contactId: id, channel: "sms", lastMessageAt: new Date() }).returning();
      thread = newThread;
    }

    const msgId = randomUUID();
    await db.insert(messagesTable).values({
      id: msgId,
      threadId: thread.id,
      direction: "outbound",
      body: parsed.data.body,
      status: "queued",
      aiAssisted: parsed.data.aiAssisted ?? false,
      toAddress: contact.phone,
    });

    await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, { to: contact.phone, body: parsed.data.body, agentId: authReq.userId });

    // Log to activity timeline
    await db.insert(activitiesTable).values({ id: randomUUID(), orgId: authReq.orgId, contactId: id, type: "sms", body: parsed.data.body, createdBy: authReq.userId });

    // Update thread lastMessageAt
    await db.update(messageThreadsTable).set({ lastMessageAt: new Date() }).where(eq(messageThreadsTable.id, thread.id));

    res.status(201).json({ messageId: msgId, threadId: thread.id });
  },
);

// POST /contacts/:id/send-email
router.post(
  "/contacts/:id/send-email",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    if (!contact.email) { res.status(400).json({ error: "Contact has no email address" }); return; }
    if (contact.optOutEmail) { res.status(400).json({ error: "Contact has opted out of email" }); return; }

    const SendEmailSchema = z.object({ subject: z.string().min(1).max(500), body: z.string().min(1), bodyText: z.string().optional(), aiAssisted: z.boolean().optional().default(false) });
    const parsed = SendEmailSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    // Find or create email thread
    let [thread] = await db.select({ id: messageThreadsTable.id }).from(messageThreadsTable).where(and(eq(messageThreadsTable.contactId, id), eq(messageThreadsTable.channel, "email"), eq(messageThreadsTable.orgId, authReq.orgId))).limit(1);
    if (!thread) {
      const [newThread] = await db.insert(messageThreadsTable).values({ id: randomUUID(), orgId: authReq.orgId, contactId: id, channel: "email", lastMessageAt: new Date() }).returning();
      thread = newThread;
    }

    const msgId = randomUUID();
    await db.insert(messagesTable).values({
      id: msgId,
      threadId: thread.id,
      direction: "outbound",
      subject: parsed.data.subject,
      body: parsed.data.body,
      status: "queued",
      aiAssisted: parsed.data.aiAssisted ?? false,
      toAddress: contact.email,
    });

    await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, { to: contact.email, subject: parsed.data.subject, html: parsed.data.body, text: parsed.data.bodyText });

    // Log to activity timeline
    await db.insert(activitiesTable).values({ id: randomUUID(), orgId: authReq.orgId, contactId: id, type: "email", body: parsed.data.subject, metadata: { subject: parsed.data.subject }, createdBy: authReq.userId });
    await db.update(messageThreadsTable).set({ lastMessageAt: new Date() }).where(eq(messageThreadsTable.id, thread.id));

    res.status(201).json({ messageId: msgId, threadId: thread.id });
  },
);

// GET /contacts/:id/threads
router.get(
  "/contacts/:id/threads",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const threads = await db.select().from(messageThreadsTable).where(and(eq(messageThreadsTable.contactId, id), eq(messageThreadsTable.orgId, authReq.orgId))).orderBy(desc(messageThreadsTable.lastMessageAt));
    res.json(threads);
  },
);

// GET /contacts/:id/messages — every message across all threads for one contact,
// ordered chronologically. Used by the contact-detail timeline to merge SMS
// and email history alongside activities.
router.get(
  "/contacts/:id/messages",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const limit = safeLimit(req.query.limit, 100, 500);

    const [contact] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, id),
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const rows = await db
      .select({
        id: messagesTable.id,
        threadId: messagesTable.threadId,
        channel: messageThreadsTable.channel,
        direction: messagesTable.direction,
        body: messagesTable.body,
        subject: messagesTable.subject,
        fromAddress: messagesTable.fromAddress,
        toAddress: messagesTable.toAddress,
        status: messagesTable.status,
        sentAt: messagesTable.sentAt,
        createdAt: messagesTable.createdAt,
      })
      .from(messagesTable)
      .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
      .where(
        and(
          eq(messageThreadsTable.contactId, id),
          eq(messageThreadsTable.orgId, authReq.orgId),
        ),
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit);

    res.json({ messages: rows, total: rows.length });
  },
);

// GET /contacts/:id/tasks
router.get(
  "/contacts/:id/tasks",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const tasks = await db.select().from(taskInstancesTable).where(and(eq(taskInstancesTable.contactId, id), eq(taskInstancesTable.orgId, authReq.orgId))).orderBy(desc(taskInstancesTable.createdAt));
    res.json(tasks);
  },
);

// GET /contacts/:id/enrollments
router.get(
  "/contacts/:id/enrollments",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const enrollments = await db
      .select({ enrollment: sequenceEnrollmentsTable, sequenceName: sequencesTable.name })
      .from(sequenceEnrollmentsTable)
      .innerJoin(sequencesTable, eq(sequenceEnrollmentsTable.sequenceId, sequencesTable.id))
      .where(eq(sequenceEnrollmentsTable.contactId, id))
      .orderBy(desc(sequenceEnrollmentsTable.enrolledAt));
    res.json(enrollments);
  },
);

// POST /contacts/bulk — bulk actions
router.post(
  "/contacts/bulk",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const BulkSchema = z.object({
      ids: z.string().array().min(1).max(200),
      action: z.enum(["assign_agent", "add_tag", "remove_tag", "set_status", "export_csv"]),
      payload: z.record(z.unknown()).optional(),
    });
    const parsed = BulkSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const { ids, action, payload } = parsed.data;

    // Verify all contacts belong to org
    const contacts = await db.select().from(contactsTable).where(and(inArray(contactsTable.id, ids), eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt)));
    if (contacts.length !== ids.length) { res.status(400).json({ error: "One or more contacts not found" }); return; }

    switch (action) {
      case "assign_agent": {
        const agentId = String(payload?.agentId ?? "");
        if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
        await db.update(contactsTable).set({ assignedAgentId: agentId }).where(inArray(contactsTable.id, ids));
        break;
      }
      case "add_tag": {
        const tag = String(payload?.tag ?? "");
        if (!tag) { res.status(400).json({ error: "tag required" }); return; }
        for (const c of contacts) {
          const newTags = [...new Set([...(c.tags ?? []), tag])];
          await db.update(contactsTable).set({ tags: newTags }).where(eq(contactsTable.id, c.id));
        }
        break;
      }
      case "remove_tag": {
        const tag = String(payload?.tag ?? "");
        for (const c of contacts) {
          const newTags = (c.tags ?? []).filter((t) => t !== tag);
          await db.update(contactsTable).set({ tags: newTags }).where(eq(contactsTable.id, c.id));
        }
        break;
      }
      case "set_status": {
        const status = String(payload?.status ?? "") as "lead" | "prospect" | "enrolled" | "retained" | "lost" | "do_not_contact";
        await db.update(contactsTable).set({ status }).where(inArray(contactsTable.id, ids));
        break;
      }
      case "export_csv": {
        const headers = ["id","firstName","lastName","email","phone","status","medicareId","currentPlanType","stateCode","zipCode","leadSource","createdAt"];
        const maskedContacts = contacts.map((c) => maskContact(c, authReq.userRole));
        const rows = maskedContacts.map((c) => headers.map((h) => {
          const v = (c as Record<string, unknown>)[h];
          return `"${String(v ?? "").replace(/"/g, '""')}"`;
        }).join(","));
        const csv = [headers.join(","), ...rows].join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
        res.send(csv);
        return;
      }
    }
    res.json({ affected: ids.length });
  },
);

export default router;
