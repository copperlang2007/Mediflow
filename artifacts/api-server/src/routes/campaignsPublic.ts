/**
 * Public (unauthenticated) campaign endpoints. Mounted in app.ts ABOVE the
 * Clerk-guarded `/api` router, like the dialer and EnrollHere receivers —
 * trust comes from a signature, never from a session.
 *
 *   POST /api/campaigns/v1/webhooks/resend      Resend events (svix-signed)
 *   POST /api/campaigns/v1/webhooks/twilio-status  Twilio delivery receipts
 *
 * Campaign email unsubscribes use the shared CAN-SPAM endpoint
 * (routes/unsubscribe.ts, GET/POST /api/public/unsubscribe) with its signed
 * org+contact token; campaign links add `r=<recipient id>` so the unsubscribe
 * is credited to the campaign (lib/campaigns/service.ts).
 *
 * Webhooks fail closed: no RESEND_WEBHOOK_SECRET → 503; bad signature →
 * 401/403. Each event is recorded once in `campaign_events` (unique on
 * provider + external id), so provider redeliveries are no-ops.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  campaignEventsTable,
  campaignRecipientsTable,
  contactsTable,
  messagesTable,
} from "@workspace/db";
import { applyEmailComplaint, refreshCampaignCounts } from "../lib/campaigns/service";
import { resendWebhookSecret, verifySvixSignature } from "../lib/campaigns/svix";
import { validateTwilioWebhookSignature } from "../lib/sms";
import { logger } from "../lib/logger";
import { isDemoMode } from "../lib/demoMode";

const router: IRouter = Router();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDemoMode() ? 2000 : 1200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false },
  message: { error: "Too many requests" },
});

// ---- Provider webhooks ------------------------------------------------------

/** Record an event once; false when this provider event was already seen. */
async function claimEvent(provider: string, externalId: string, eventType: string, recipientId: string | null): Promise<boolean> {
  const inserted = await db
    .insert(campaignEventsTable)
    .values({ id: randomUUID(), provider, externalId: externalId.slice(0, 256), eventType: eventType.slice(0, 64), recipientId })
    .onConflictDoNothing({ target: [campaignEventsTable.provider, campaignEventsTable.externalId] })
    .returning({ id: campaignEventsTable.id });
  return inserted.length > 0;
}

async function findRecipient(providerMessageId: string, channel: "email" | "sms") {
  const [r] = await db
    .select()
    .from(campaignRecipientsTable)
    .where(and(eq(campaignRecipientsTable.providerMessageId, providerMessageId), eq(campaignRecipientsTable.channel, channel)))
    .limit(1);
  return r ?? null;
}

async function setMessageStatus(messageId: string | null, status: "delivered" | "failed"): Promise<void> {
  if (!messageId) return;
  await db.update(messagesTable).set({ status }).where(eq(messagesTable.id, messageId));
}

router.post(
  "/api/campaigns/v1/webhooks/resend",
  webhookLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const secret = resendWebhookSecret();
    if (!secret) {
      res.status(503).json({ error: "Email tracking webhook is not configured" });
      return;
    }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const header = (n: string): string | undefined => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const ok = verifySvixSignature({
      secret,
      id: header("svix-id"),
      timestamp: header("svix-timestamp"),
      signature: header("svix-signature"),
      rawBody: raw ? raw.toString("utf8") : "",
    });
    if (!ok) {
      logger.warn("Resend webhook: invalid signature — rejected");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const evt = req.body as { type?: string; data?: { email_id?: string } };
    const type = String(evt?.type ?? "");
    const emailId = evt?.data?.email_id;
    if (!type || !emailId) {
      res.json({ received: true, ignored: "no email id" });
      return;
    }
    const recipient = await findRecipient(emailId, "email");
    const fresh = await claimEvent("resend", header("svix-id")!, type, recipient?.id ?? null);
    if (!fresh || !recipient) {
      res.json({ received: true, duplicate: !fresh });
      return;
    }

    const now = new Date();
    const r = campaignRecipientsTable;
    const where = eq(r.id, recipient.id);
    switch (type) {
      case "email.delivered":
        await db
          .update(r)
          .set({ deliveredAt: sql`coalesce(${r.deliveredAt}, ${now})`, status: sql`CASE WHEN ${r.status} = 'sent' THEN 'delivered'::campaign_recipient_status ELSE ${r.status} END` })
          .where(where);
        await setMessageStatus(recipient.messageId, "delivered");
        break;
      case "email.opened":
        await db.update(r).set({ openedAt: sql`coalesce(${r.openedAt}, ${now})` }).where(where);
        break;
      case "email.clicked":
        await db
          .update(r)
          .set({ clickedAt: sql`coalesce(${r.clickedAt}, ${now})`, openedAt: sql`coalesce(${r.openedAt}, ${now})` })
          .where(where);
        break;
      case "email.bounced":
        await db
          .update(r)
          .set({ status: "bounced", bouncedAt: sql`coalesce(${r.bouncedAt}, ${now})`, error: "Bounced" })
          .where(where);
        await setMessageStatus(recipient.messageId, "failed");
        break;
      case "email.complained":
        // A spam complaint is treated as an unsubscribe (CAN-SPAM best practice).
        await applyEmailComplaint({
          orgId: recipient.orgId,
          contactId: recipient.contactId,
          recipientId: recipient.id,
        });
        break;
      default:
        break;
    }
    await refreshCampaignCounts(recipient.campaignId);
    res.json({ received: true });
  },
);

router.post(
  "/api/campaigns/v1/webhooks/twilio-status",
  webhookLimiter,
  async (req: Request, res: Response): Promise<void> => {
    // Same canonical-URL reconstruction as the inbound SMS webhook.
    const publicHost = process.env.TWILIO_WEBHOOK_PUBLIC_HOST?.trim();
    let fullUrl: string;
    if (publicHost) {
      fullUrl = `${publicHost.replace(/\/+$/, "")}${req.originalUrl}`;
    } else {
      const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
      const host = (req.headers["host"] as string | undefined) ?? "";
      fullUrl = `${proto}://${host}${req.originalUrl}`;
    }
    const rawSig = req.headers["x-twilio-signature"];
    const signature = Array.isArray(rawSig) ? (rawSig[0] ?? "") : (rawSig ?? "");
    const params = (req.body ?? {}) as Record<string, string>;
    if (!validateTwilioWebhookSignature(fullUrl, params, signature)) {
      logger.warn("Twilio status callback: invalid signature — rejected");
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }

    const sid = params.MessageSid;
    const status = String(params.MessageStatus ?? "").toLowerCase();
    if (!sid || !status) {
      res.status(204).send();
      return;
    }
    const recipient = await findRecipient(sid, "sms");
    const fresh = await claimEvent("twilio", `${sid}:${status}`, status, recipient?.id ?? null);
    if (!fresh || !recipient) {
      res.status(204).send();
      return;
    }
    const now = new Date();
    const r = campaignRecipientsTable;
    if (status === "delivered") {
      await db
        .update(r)
        .set({ status: "delivered", deliveredAt: sql`coalesce(${r.deliveredAt}, ${now})` })
        .where(and(eq(r.id, recipient.id), sql`${r.status} IN ('sent','delivered')`));
      await setMessageStatus(recipient.messageId, "delivered");
    } else if (status === "undelivered" || status === "failed") {
      const code = params.ErrorCode ? ` (Twilio error ${String(params.ErrorCode).slice(0, 10)})` : "";
      await db
        .update(r)
        .set({ status: "failed", error: `Carrier reported ${status}${code}` })
        .where(eq(r.id, recipient.id));
      await setMessageStatus(recipient.messageId, "failed");
    }
    await refreshCampaignCounts(recipient.campaignId);
    res.status(204).send();
  },
);

export default router;
