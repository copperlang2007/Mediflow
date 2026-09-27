/**
 * Send-time delivery for scheduled SMS / email jobs.
 *
 * Jobs that carry `consumer` context go through the compliance gate
 * (consumerOutreach.ts) immediately before the provider call:
 *   - block  → nothing is sent; the reason is logged (ids only) and counted.
 *   - defer  → the job is re-enqueued to start when the recipient's legal
 *              texting window opens.
 *   - send   → the message goes to the contact's CURRENT address. Automated
 *              emails get the unsubscribe footer + List-Unsubscribe headers,
 *              and automated sends are written to the contact's message
 *              history so outreach is reconstructable on a complaint.
 *
 * Jobs without `consumer` context are internal/system mail (license alerts,
 * invitations, reports) and are sent as before; SMS still passes the opt-out
 * check inside sendSMS.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, messageThreadsTable, messagesTable } from "@workspace/db";
import { logger } from "../logger";
import { sendEmail, fromHeaderFor } from "../email";
import { sendSMS } from "../sms";
import {
  evaluateConsumerEmail,
  evaluateConsumerSms,
  type ConsumerContext,
} from "./consumerOutreach";
import { unsubscribeFooterHtml, unsubscribeHeaders } from "./unsubscribe";
import type { SendScheduledEmailPayload, SendScheduledSmsPayload } from "../jobs";

type ScheduledSmsJob = SendScheduledSmsPayload;
type ScheduledEmailJob = SendScheduledEmailPayload;

export type DeliveryOutcome = "sent" | "failed" | "blocked" | "deferred";

/** Re-enqueue hook — injected so this module never imports the queue itself. */
export type DeferFn = (job: ScheduledSmsJob, startAfter: Date) => Promise<void>;

async function recordOutbound(
  ctx: ConsumerContext,
  channel: "sms" | "email",
  fields: { body: string; subject?: string; toAddress: string; ok: boolean; providerMessageId?: string },
): Promise<void> {
  try {
    const now = new Date();
    const [existing] = await db
      .select({ id: messageThreadsTable.id })
      .from(messageThreadsTable)
      .where(
        and(
          eq(messageThreadsTable.orgId, ctx.orgId),
          eq(messageThreadsTable.contactId, ctx.contactId),
          eq(messageThreadsTable.channel, channel),
        ),
      )
      .limit(1);
    let threadId = existing?.id;
    if (!threadId) {
      threadId = randomUUID();
      await db.insert(messageThreadsTable).values({
        id: threadId,
        orgId: ctx.orgId,
        contactId: ctx.contactId,
        channel,
        lastMessageAt: now,
      });
    } else {
      await db.update(messageThreadsTable).set({ lastMessageAt: now }).where(eq(messageThreadsTable.id, threadId));
    }
    await db.insert(messagesTable).values({
      id: randomUUID(),
      threadId,
      direction: "outbound",
      body: fields.body,
      subject: fields.subject ?? null,
      toAddress: fields.toAddress,
      status: fields.ok ? "sent" : "failed",
      providerMessageId: fields.providerMessageId ?? null,
      sentAt: fields.ok ? now : null,
    });
  } catch (err) {
    // History is secondary to delivery — never fail the job over it.
    logger.error({ err, contactId: ctx.contactId, channel }, "Failed to record automated outreach in message history");
  }
}

export async function deliverScheduledSms(
  job: ScheduledSmsJob,
  defer: DeferFn,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  if (!job.consumer) {
    const result = await sendSMS(job.to, job.body, job.agentId ?? "system");
    return result.success ? "sent" : "failed";
  }

  const ctx = job.consumer;
  const decision = await evaluateConsumerSms(ctx, now);
  if (decision.action === "block") {
    logger.info({ contactId: ctx.contactId, orgId: ctx.orgId, reason: decision.reason }, "Consumer SMS blocked by compliance gate");
    return "blocked";
  }
  if (decision.action === "defer") {
    await defer(job, decision.until);
    logger.info({ contactId: ctx.contactId, orgId: ctx.orgId, until: decision.until.toISOString() }, "Consumer SMS deferred to recipient's texting window");
    return "deferred";
  }

  const result = await sendSMS(decision.to, job.body, job.agentId ?? "system");
  if (ctx.automated) {
    await recordOutbound(ctx, "sms", {
      body: job.body,
      toAddress: decision.to,
      ok: result.success,
      providerMessageId: result.success ? result.sid : undefined,
    });
  }
  return result.success ? "sent" : "failed";
}

export async function deliverScheduledEmail(job: ScheduledEmailJob): Promise<DeliveryOutcome> {
  if (!job.consumer) {
    const toArray = Array.isArray(job.to) ? job.to : [job.to];
    const result = await sendEmail({
      to: toArray.map((email) => ({ email })),
      subject: job.subject,
      html: job.html,
      text: job.text,
      replyTo: job.replyTo,
      tags: job.tags,
      from: fromHeaderFor(job.fromName),
    });
    return result.success ? "sent" : "failed";
  }

  const ctx = job.consumer;
  const decision = await evaluateConsumerEmail(ctx);
  if (decision.action === "block") {
    const log = { contactId: ctx.contactId, orgId: ctx.orgId, reason: decision.reason };
    // A missing unsubscribe link is a deployment fault, not a consumer choice.
    if (decision.reason === "unsubscribe_unavailable") {
      logger.error(log, "Automated consumer email held: unsubscribe link unavailable (check APP_BASE_URL / PHI_HMAC_KEY)");
    } else {
      logger.info(log, "Consumer email blocked by compliance gate");
    }
    return "blocked";
  }

  const url = decision.unsubscribeUrl;
  const html = url ? `${job.html}${unsubscribeFooterHtml(url)}` : job.html;
  const text = job.text && url ? `${job.text}\n\nUnsubscribe: ${url}` : job.text;
  const result = await sendEmail({
    to: { email: decision.to },
    subject: job.subject,
    html,
    text,
    replyTo: job.replyTo,
    tags: job.tags,
    from: fromHeaderFor(job.fromName),
    headers: url ? unsubscribeHeaders(url) : undefined,
  });
  if (ctx.automated) {
    await recordOutbound(ctx, "email", {
      body: job.text ?? job.html,
      subject: job.subject,
      toAddress: decision.to,
      ok: result.success,
      providerMessageId: result.success ? result.id : undefined,
    });
  }
  return result.success ? "sent" : "failed";
}
