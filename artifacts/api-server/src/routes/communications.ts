import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, lt } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  messageThreadsTable,
  messagesTable,
  contactsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router();

// GET /threads — list all message threads for org
router.get(
  "/threads",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { channel, limit, offset } = req.query as Record<string, string | undefined>;

    const conditions = [eq(messageThreadsTable.orgId, authReq.orgId)];
    if (channel) conditions.push(eq(messageThreadsTable.channel, channel as "sms" | "email"));

    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);

    const threads = await db
      .select({
        thread: messageThreadsTable,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        contactPhone: contactsTable.phone,
        contactEmail: contactsTable.email,
        unreadCount: sql<number>`count(${messagesTable.id}) filter (where ${messagesTable.direction} = 'inbound' and ${messagesTable.status} = 'received')`,
        lastMessage: sql<string | null>`(select body from messages where thread_id = ${messageThreadsTable.id} order by created_at desc limit 1)`,
      })
      .from(messageThreadsTable)
      .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
      .leftJoin(messagesTable, eq(messagesTable.threadId, messageThreadsTable.id))
      .where(and(...conditions))
      .groupBy(messageThreadsTable.id, contactsTable.id)
      .orderBy(desc(messageThreadsTable.lastMessageAt))
      .limit(limitNum)
      .offset(offsetNum);

    res.json(threads);
  },
);

// GET /threads/:id/messages
router.get(
  "/threads/:id/messages",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Verify thread belongs to org
    const [thread] = await db
      .select({ id: messageThreadsTable.id })
      .from(messageThreadsTable)
      .where(and(eq(messageThreadsTable.id, id), eq(messageThreadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }

    const limitNum = safeLimit(req.query.limit, 100, 500);
    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.threadId, id))
      .orderBy(desc(messagesTable.createdAt))
      .limit(limitNum);

    res.json(messages.reverse());
  },
);

// POST /threads/:id/reply — reply in a thread
router.post(
  "/threads/:id/reply",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const threadId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [thread] = await db
      .select({ id: messageThreadsTable.id, contactId: messageThreadsTable.contactId, channel: messageThreadsTable.channel })
      .from(messageThreadsTable)
      .where(and(eq(messageThreadsTable.id, threadId), eq(messageThreadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }

    const [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, thread.contactId)).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const ReplySchema = z.object({
      body: z.string().min(1).max(5000),
      subject: z.string().optional(),
      aiAssisted: z.boolean().optional().default(false),
    });
    const parsed = ReplySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    if (thread.channel === "sms") {
      if (!contact.phone) { res.status(400).json({ error: "Contact has no phone number" }); return; }
      if (contact.optOutSms) { res.status(400).json({ error: "Contact has opted out of SMS" }); return; }
      await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, {
        to: contact.phone,
        body: parsed.data.body,
        consumer: { orgId: authReq.orgId, contactId: contact.id, automated: false },
      });
    } else {
      if (!contact.email) { res.status(400).json({ error: "Contact has no email" }); return; }
      if (contact.optOutEmail) { res.status(400).json({ error: "Contact has opted out of email" }); return; }
      await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
        to: contact.email,
        subject: parsed.data.subject ?? "(no subject)",
        html: `<p>${parsed.data.body.replace(/\n/g, "<br>")}</p>`,
        consumer: { orgId: authReq.orgId, contactId: contact.id, automated: false },
      });
    }

    const msgId = randomUUID();
    const [msg] = await db.insert(messagesTable).values({
      id: msgId,
      threadId,
      direction: "outbound",
      body: parsed.data.body,
      subject: parsed.data.subject ?? null,
      status: "queued",
      aiAssisted: parsed.data.aiAssisted ?? false,
      toAddress: thread.channel === "sms" ? (contact.phone ?? undefined) : (contact.email ?? undefined),
    }).returning();

    await db.update(messageThreadsTable).set({ lastMessageAt: new Date() }).where(and(eq(messageThreadsTable.id, threadId), eq(messageThreadsTable.orgId, authReq.orgId)));

    res.status(201).json(msg);
  },
);

// GET /inbox — unread inbound messages across all contacts
router.get(
  "/inbox",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { channel, limit, offset } = req.query as Record<string, string | undefined>;
    const limitNum = safeLimit(limit, 50, 500);
    const offsetNum = safeOffset(offset);

    const conditions = [
      eq(messageThreadsTable.orgId, authReq.orgId),
      eq(messagesTable.direction, "inbound"),
      eq(messagesTable.status, "received"),
    ];
    if (channel) conditions.push(eq(messageThreadsTable.channel, channel as "sms" | "email"));

    const messages = await db
      .select({
        message: messagesTable,
        channel: messageThreadsTable.channel,
        contactId: messageThreadsTable.contactId,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        contactPhone: contactsTable.phone,
        contactEmail: contactsTable.email,
      })
      .from(messagesTable)
      .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
      .innerJoin(contactsTable, eq(messageThreadsTable.contactId, contactsTable.id))
      .where(and(...conditions))
      .orderBy(desc(messagesTable.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(messagesTable)
      .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
      .where(and(eq(messageThreadsTable.orgId, authReq.orgId), eq(messagesTable.direction, "inbound"), eq(messagesTable.status, "received")));

    res.json({ data: messages, total: Number(total[0]?.count ?? 0) });
  },
);

// PATCH /messages/:id/read — mark message as read
router.patch(
  "/messages/:id/read",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Verify ownership via thread → org
    const [msg] = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
      .where(and(eq(messagesTable.id, id), eq(messageThreadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!msg) { res.status(404).json({ error: "Message not found" }); return; }

    await db.update(messagesTable).set({ status: "delivered" }).where(eq(messagesTable.id, id));
    res.json({ success: true });
  },
);

export default router;
