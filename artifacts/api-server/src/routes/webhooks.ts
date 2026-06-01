/**
 * Inbound webhook routes (not under /api — no Clerk auth middleware).
 *
 * POST /webhooks/twilio/sms — Twilio inbound SMS (HMAC-SHA1 signature validated)
 *
 * Opt-out / opt-in / help keywords are handled per TCPA compliance.
 * All other inbound messages are stored in message_threads + messages
 * for agent follow-up.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, isNotNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  contactsTable,
  optOutsTable,
  messageThreadsTable,
  messagesTable,
  agentsTable,
} from "@workspace/db";
import {
  validateTwilioWebhookSignature,
  classifyInboundMessage,
  type TwilioInboundPayload,
} from "../lib/sms";
import { broadcastToUser } from "../lib/sseManager";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * POST /webhooks/twilio/sms
 *
 * Validates X-Twilio-Signature before processing any data.
 * Returns TwiML XML — empty <Response> unless an auto-reply is needed.
 */
router.post(
  "/webhooks/twilio/sms",
  async (req: Request, res: Response): Promise<void> => {
    // Reconstruct the canonical URL Twilio signed. Prefer the
    // operator-configured TWILIO_WEBHOOK_PUBLIC_HOST (e.g.
    // "https://mediflow.app") over attacker-controllable Host /
    // X-Forwarded-Proto headers — a header-mismatch behind a misbehaving
    // proxy would otherwise silently reject legitimate inbound SMS.
    // When the env var is unset we fall back to the header-based path so
    // local dev (ngrok / tunnel-style) workflows keep working.
    const publicHost = process.env.TWILIO_WEBHOOK_PUBLIC_HOST?.trim();
    let fullUrl: string;
    if (publicHost) {
      const trimmedHost = publicHost.replace(/\/+$/, "");
      fullUrl = `${trimmedHost}${req.originalUrl}`;
    } else {
      const proto =
        (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
      const host = (req.headers["host"] as string | undefined) ?? "";
      fullUrl = `${proto}://${host}${req.originalUrl}`;
    }

    const rawSig = req.headers["x-twilio-signature"];
    const signature = Array.isArray(rawSig) ? rawSig[0] : (rawSig ?? "");
    const params = req.body as Record<string, string>;

    if (!validateTwilioWebhookSignature(fullUrl, params, signature)) {
      logger.warn({ url: fullUrl }, "Twilio webhook: invalid signature — rejected");
      res.status(403).type("text/xml").send("<Response></Response>");
      return;
    }

    const payload = params as TwilioInboundPayload;
    const { From: from, To: to, Body: body, MessageSid: messageSid } = payload;

    if (!from || !body) {
      res.status(400).type("text/xml").send("<Response></Response>");
      return;
    }

    logger.info({ from, messageSid }, "Twilio inbound SMS received");

    const { isOptOut, isOptIn, isHelp } = classifyInboundMessage(body);

    try {
      // --- TCPA Opt-out ---
      if (isOptOut) {
        // Wrap update -> select -> audit insert in a single transaction
        // so the audit row is never lost if the SELECT or INSERT fails
        // after the contact flag has already been flipped. The audit
        // dedup itself is enforced by the partial unique index
        // `opt_outs_org_phone_channel_unique` (migration 0013) — the
        // conflict target below tells Postgres to use it.
        await db.transaction(async (tx) => {
          // Set flag on contact record (idempotent on retries)
          await tx
            .update(contactsTable)
            .set({ optOutSms: true })
            .where(eq(contactsTable.phone, from));

          // Record in opt_outs log (find orgId via contact)
          const [contact] = await tx
            .select({ orgId: contactsTable.orgId })
            .from(contactsTable)
            .where(eq(contactsTable.phone, from))
            .limit(1);

          if (contact) {
            // Use the (org_id, phone, channel) unique index as the
            // conflict target. Without an explicit target, drizzle would
            // fall back to the PK (`id`), which is a random UUID and
            // never collides — so concurrent STOPs would each insert a
            // distinct audit row.
            await tx
              .insert(optOutsTable)
              .values({
                id: randomUUID(),
                orgId: contact.orgId,
                phone: from,
                channel: "sms",
              })
              .onConflictDoNothing({
                target: [
                  optOutsTable.orgId,
                  optOutsTable.phone,
                  optOutsTable.channel,
                ],
              });
          }
        });

        logger.info({ from }, "Contact opted out of SMS");
        res
          .type("text/xml")
          .send(
            "<Response><Message>You have been unsubscribed and will receive no further messages. Reply START to re-subscribe.</Message></Response>",
          );
        return;
      }

      // --- Opt-in ---
      if (isOptIn) {
        await db
          .update(contactsTable)
          .set({ optOutSms: false })
          .where(eq(contactsTable.phone, from));

        logger.info({ from }, "Contact re-opted in to SMS");
        res
          .type("text/xml")
          .send(
            "<Response><Message>You have been re-subscribed. Reply STOP at any time to unsubscribe.</Message></Response>",
          );
        return;
      }

      // --- Help ---
      if (isHelp) {
        res
          .type("text/xml")
          .send(
            "<Response><Message>MediFlow Medicare Agency. Reply STOP to unsubscribe. For support contact your agent directly.</Message></Response>",
          );
        return;
      }

      // --- Normal inbound: store for agent follow-up ---
      const [contact] = await db
        .select()
        .from(contactsTable)
        .where(eq(contactsTable.phone, from))
        .limit(1);

      if (contact) {
        // Find or create an open SMS thread for this contact
        let [thread] = await db
          .select()
          .from(messageThreadsTable)
          .where(
            and(
              eq(messageThreadsTable.contactId, contact.id),
              eq(messageThreadsTable.channel, "sms"),
            ),
          )
          .limit(1);

        if (!thread) {
          const [newThread] = await db
            .insert(messageThreadsTable)
            .values({
              id: randomUUID(),
              orgId: contact.orgId,
              contactId: contact.id,
              channel: "sms",
              lastMessageAt: new Date(),
            })
            .returning();
          thread = newThread;
        } else {
          await db
            .update(messageThreadsTable)
            .set({ lastMessageAt: new Date() })
            .where(eq(messageThreadsTable.id, thread.id));
        }

        // Dedupe on Twilio's MessageSid. Twilio retries any non-2xx response
        // (and occasionally retries on success if their ACK times out), so
        // without this guard the same inbound message would be inserted —
        // and the SSE notification re-fired — on every retry.
        //
        // The partial unique index on (provider_message_id) WHERE NOT NULL
        // (migration 0008) makes this an atomic insert-or-skip. If
        // `inserted` is empty the row was already stored on a previous
        // delivery and we must NOT broadcast again.
        const inserted = await db
          .insert(messagesTable)
          .values({
            id: randomUUID(),
            threadId: thread.id,
            direction: "inbound",
            body,
            fromAddress: from,
            toAddress: to,
            providerMessageId: messageSid,
            status: "received",
            sentAt: new Date(),
          })
          .onConflictDoNothing({
            target: messagesTable.providerMessageId,
            // Match the partial unique index predicate from migration 0008
            // (`WHERE provider_message_id IS NOT NULL`) so Postgres can
            // infer the right constraint.
            where: isNotNull(messagesTable.providerMessageId),
          })
          .returning({ id: messagesTable.id });

        if (inserted.length === 0) {
          logger.info(
            { contactId: contact.id, threadId: thread.id, messageSid },
            "Inbound SMS duplicate retry — skipping SSE broadcast",
          );
          // Still ack 200 to Twilio so they stop retrying.
          res.type("text/xml").send("<Response></Response>");
          return;
        }

        logger.info(
          { contactId: contact.id, threadId: thread.id },
          "Inbound SMS stored",
        );

        // Notify the assigned agent (if any) via SSE — only on the
        // first delivery, since `inserted.length > 0` here.
        if (contact.assignedAgentId) {
          const [assignedAgent] = await db
            .select({ userId: agentsTable.userId })
            .from(agentsTable)
            .where(eq(agentsTable.id, contact.assignedAgentId))
            .limit(1);

          if (assignedAgent?.userId) {
            broadcastToUser(assignedAgent.userId, {
              type: "inbound_sms",
              threadId: thread.id,
              contactId: contact.id,
            });
          }
        }
      } else {
        logger.info({ from }, "Inbound SMS from unknown number — no contact found");
      }

      res.type("text/xml").send("<Response></Response>");
    } catch (err) {
      logger.error({ err, from, messageSid }, "Failed to process inbound SMS");
      res.type("text/xml").send("<Response></Response>");
    }
  },
);

export default router;
