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
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  contactsTable,
  optOutsTable,
  messageThreadsTable,
  messagesTable,
} from "@workspace/db";
import {
  validateTwilioWebhookSignature,
  classifyInboundMessage,
  type TwilioInboundPayload,
} from "../lib/sms";
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
    // Reconstruct the canonical URL Twilio signed
    const proto =
      (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host =
      (req.headers["host"] as string | undefined) ??
      process.env.REPLIT_DEV_DOMAIN ??
      "";
    const fullUrl = `${proto}://${host}${req.originalUrl}`;

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
        // Set flag on contact record
        await db
          .update(contactsTable)
          .set({ optOutSms: true })
          .where(eq(contactsTable.phone, from));

        // Record in opt_outs log (find orgId via contact)
        const [contact] = await db
          .select({ orgId: contactsTable.orgId })
          .from(contactsTable)
          .where(eq(contactsTable.phone, from))
          .limit(1);

        if (contact) {
          await db
            .insert(optOutsTable)
            .values({
              id: randomUUID(),
              orgId: contact.orgId,
              phone: from,
              channel: "sms",
            })
            .onConflictDoNothing();
        }

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

        await db.insert(messagesTable).values({
          id: randomUUID(),
          threadId: thread.id,
          direction: "inbound",
          body,
          fromAddress: from,
          toAddress: to,
          providerMessageId: messageSid,
          status: "received",
          sentAt: new Date(),
        });

        logger.info(
          { contactId: contact.id, threadId: thread.id },
          "Inbound SMS stored",
        );
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
