/**
 * Public (unauthenticated) campaign endpoints. Mounted in app.ts ABOVE the
 * Clerk-guarded `/api` router, like the dialer and EnrollHere receivers —
 * trust comes from a signature, never from a session.
 *
 *   GET  /api/campaigns/v1/unsubscribe/:token   confirmation page
 *   POST /api/campaigns/v1/unsubscribe/:token   unsubscribe (form button, or
 *                                               RFC 8058 one-click POST from
 *                                               the mailbox provider)
 *   POST /api/campaigns/v1/webhooks/resend      Resend events (svix-signed)
 *   POST /api/campaigns/v1/webhooks/twilio-status  Twilio delivery receipts
 *
 * Unsubscribe tokens are HMAC-signed (lib/campaigns/unsubscribeToken.ts);
 * every failure renders the same generic page so the endpoint is not an
 * oracle, and the routes are rate-limited per IP.
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
import { verifyUnsubscribeToken } from "../lib/campaigns/unsubscribeToken";
import { applyEmailUnsubscribe, loadSenderSettings, refreshCampaignCounts } from "../lib/campaigns/service";
import { escapeHtml } from "../lib/campaigns/render";
import { resendWebhookSecret, verifySvixSignature } from "../lib/campaigns/svix";
import { validateTwilioWebhookSignature } from "../lib/sms";
import { logger } from "../lib/logger";
import { isDemoMode } from "../lib/demoMode";

const router: IRouter = Router();

const unsubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false },
  message: "Too many requests. Please try again in a minute.",
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDemoMode() ? 2000 : 1200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false },
  message: { error: "Too many requests" },
});

function page(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#f1f5f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
.card{max-width:440px;margin:12vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 8px}p{color:#475569;line-height:1.55;margin:0 0 16px}
button{background:#1e3a5f;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

const INVALID_PAGE = page(
  "Link not valid",
  `<h1>This link isn't valid</h1><p>The unsubscribe link is incomplete or has expired. To stop marketing email, reply to any message and ask to be removed, or contact the agency directly.</p>`,
);

function tokenParam(req: Request): string {
  const v = req.params.token;
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

type Resolved = { orgId: string; contactId: string; recipientId: string | null };

async function resolveToken(token: string): Promise<Resolved | null> {
  const subject = verifyUnsubscribeToken(token);
  if (!subject) return null;
  if (subject.kind === "r") {
    const [r] = await db
      .select({ orgId: campaignRecipientsTable.orgId, contactId: campaignRecipientsTable.contactId })
      .from(campaignRecipientsTable)
      .where(eq(campaignRecipientsTable.id, subject.id))
      .limit(1);
    return r ? { orgId: r.orgId, contactId: r.contactId, recipientId: subject.id } : null;
  }
  const [c] = await db
    .select({ orgId: contactsTable.orgId, id: contactsTable.id })
    .from(contactsTable)
    .where(eq(contactsTable.id, subject.id))
    .limit(1);
  return c ? { orgId: c.orgId, contactId: c.id, recipientId: null } : null;
}

router.get(
  "/api/campaigns/v1/unsubscribe/:token",
  unsubscribeLimiter,
  async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const resolved = await resolveToken(tokenParam(req));
    if (!resolved) {
      res.status(400).type("html").send(INVALID_PAGE);
      return;
    }
    const sender = await loadSenderSettings(resolved.orgId);
    res.type("html").send(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe from ${escapeHtml(sender.agencyName)} emails?</h1>
<p>You will stop receiving marketing email from ${escapeHtml(sender.agencyName)}. Messages about an application or policy you have with us may still be sent.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  },
);

router.post(
  "/api/campaigns/v1/unsubscribe/:token",
  unsubscribeLimiter,
  async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const resolved = await resolveToken(tokenParam(req));
    if (!resolved) {
      res.status(400).type("html").send(INVALID_PAGE);
      return;
    }
    const oneClick =
      typeof req.body === "object" &&
      req.body !== null &&
      (req.body as Record<string, unknown>)["List-Unsubscribe"] === "One-Click";
    try {
      await applyEmailUnsubscribe({
        orgId: resolved.orgId,
        contactId: resolved.contactId,
        recipientId: resolved.recipientId,
        source: oneClick ? "one_click" : "unsubscribe_link",
      });
    } catch (err) {
      logger.error({ err }, "Unsubscribe failed");
      res.status(500).type("html").send(page("Something went wrong", "<h1>Something went wrong</h1><p>Please try again in a moment.</p>"));
      return;
    }
    const sender = await loadSenderSettings(resolved.orgId);
    res.type("html").send(
      page(
        "Unsubscribed",
        `<h1>You're unsubscribed</h1><p>${escapeHtml(sender.agencyName)} will not send you marketing email anymore. It can take up to a day for messages already on their way to stop.</p>`,
      ),
    );
  },
);

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
        await applyEmailUnsubscribe({
          orgId: recipient.orgId,
          contactId: recipient.contactId,
          recipientId: recipient.id,
          source: "complaint",
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
