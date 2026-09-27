/**
 * Campaign send worker (pg-boss job `campaign-send`).
 *
 * One run:
 *   1. Loads the campaign; stops if it is draft / sent / cancelled.
 *   2. Marks it `sending` and materializes the audience into
 *      `campaign_recipients` (idempotent — unique (campaign_id, contact_id)).
 *   3. Sends to at most MAX_PER_RUN queued recipients, throttled to
 *      CAMPAIGN_SEND_RATE_PER_SECOND, then re-enqueues itself if work remains.
 *
 * Idempotency (at-most-once per recipient): before any provider call the
 * worker CLAIMS the recipient with
 *   UPDATE campaign_recipients SET claimed_at = now()
 *   WHERE id = ? AND status = 'queued' AND claimed_at IS NULL RETURNING id
 * Only the worker that gets the row back sends. A retried or duplicate job
 * finds the row already claimed and skips it, so a crash between the provider
 * call and the status write can never produce a second message. Rows left
 * claimed-but-unfinished by a crashed run are closed out as `failed` with an
 * explanatory error rather than being re-sent.
 *
 * Compliance at send time (re-checked per recipient, not only at snapshot)
 * goes through the ONE consumer outreach gate (lib/compliance/
 * consumerOutreach.ts, automated = true), the same gate sequences and
 * automation rules use:
 *   - deleted / do-not-contact contacts, opt-out flags and the opt_outs
 *     suppression / STOP lists (phone matched on its last 10 digits);
 *   - SMS: TCPA prior express written consent when the org requires it, and
 *     the recipient's legal texting window (federal 8am–9pm plus narrower
 *     state windows). Out-of-window recipients stay queued and the job
 *     re-enqueues itself for the earliest window;
 *   - email: the shared signed unsubscribe link (lib/compliance/
 *     unsubscribe.ts) in a CAN-SPAM footer with the agency's physical
 *     address, plus `List-Unsubscribe` + `List-Unsubscribe-Post` headers.
 * SMS also gets "Reply STOP to opt out." on the contact's first campaign SMS.
 */
import { and, eq, inArray, isNull, lt, ne, sql, isNotNull } from "drizzle-orm";
import {
  db,
  agentsTable,
  campaignRecipientsTable,
  campaignsTable,
  carriersTable,
  contactsTable,
  type Campaign,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { sendEmail, isEmailConfigured } from "../lib/email";
import { sendSms, isConfigured as isSmsConfigured } from "../lib/sms";
import { materializeRecipients } from "../lib/campaigns/audience";
import {
  applyMergeFields,
  emailFooterHtml,
  emailFooterText,
  htmlToText,
  withStopLine,
  wrapEmailHtml,
  type MergeContext,
} from "../lib/campaigns/render";
import {
  campaignUnsubscribeUrl,
  configuredPublicBaseUrl,
  loadSenderSettings,
  recordOutboundMessage,
  refreshCampaignCounts,
  senderIdentity,
  unsubscribeLinksAvailable,
} from "../lib/campaigns/service";
import {
  evaluateConsumerEmail,
  evaluateConsumerSms,
  type BlockReason,
  type ConsumerContext,
} from "../lib/compliance/consumerOutreach";
import { unsubscribeHeaders } from "../lib/compliance/unsubscribe";

export interface CampaignSendPayload extends Record<string, unknown> {
  campaignId: string;
  orgId: string;
}

export const MAX_PER_RUN = 500;
/** A claim older than this with no outcome is treated as a crashed send. */
export const STRANDED_CLAIM_MS = 10 * 60_000;

export interface CampaignSendDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function throttleMs(channel: "email" | "sms"): number {
  const configured = Number(process.env.CAMPAIGN_SEND_RATE_PER_SECOND);
  const rate = Number.isFinite(configured) && configured > 0 ? configured : channel === "sms" ? 1 : 10;
  return Math.floor(1000 / rate);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function safeDisplayName(name: string): string {
  return name.replace(/["<>\r\n\\]/g, "").slice(0, 100).trim();
}

export function twilioStatusCallbackUrl(): string | undefined {
  if (!process.env.TWILIO_AUTH_TOKEN) return undefined;
  const host = process.env.TWILIO_WEBHOOK_PUBLIC_HOST?.trim() || configuredPublicBaseUrl();
  if (!host) return undefined;
  return `${host.replace(/\/+$/, "")}/api/campaigns/v1/webhooks/twilio-status`;
}

/** Recipient outcome for a consumer-gate block. */
function skipFor(reason: BlockReason): { status: "skipped_opt_out" | "failed"; error: string } {
  switch (reason) {
    case "opted_out":
      return { status: "skipped_opt_out", error: "Opted out before send" };
    case "no_tcpa_consent":
      return { status: "failed", error: "No TCPA consent on file" };
    case "no_destination":
      return { status: "failed", error: "Contact no longer has an address" };
    case "unsubscribe_unavailable":
      return { status: "failed", error: "Unsubscribe link unavailable" };
    default:
      return { status: "failed", error: "Contact no longer eligible" };
  }
}

async function failAllQueued(campaignId: string, error: string): Promise<void> {
  await db
    .update(campaignRecipientsTable)
    .set({ status: "failed", error, claimedAt: new Date() })
    .where(
      and(
        eq(campaignRecipientsTable.campaignId, campaignId),
        eq(campaignRecipientsTable.status, "queued"),
        isNull(campaignRecipientsTable.claimedAt),
      ),
    );
}

export async function campaignSendWorker(
  data: CampaignSendPayload,
  deps: CampaignSendDeps = {},
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? ((): Date => new Date());

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, data.campaignId), eq(campaignsTable.orgId, data.orgId)))
    .limit(1);
  if (!campaign) {
    logger.warn({ campaignId: data.campaignId }, "Campaign not found — send job dropped");
    return;
  }
  if (campaign.status !== "scheduled" && campaign.status !== "sending") {
    logger.info({ campaignId: campaign.id, status: campaign.status }, "Campaign not sendable — skipping");
    return;
  }
  if (campaign.scheduledAt && campaign.scheduledAt.getTime() > now().getTime() + 60_000) {
    await enqueue(JOB_NAMES.CAMPAIGN_SEND, data, { startAfter: campaign.scheduledAt });
    return;
  }

  if (campaign.status === "scheduled") {
    await db
      .update(campaignsTable)
      .set({ status: "sending", startedAt: campaign.startedAt ?? now() })
      .where(and(eq(campaignsTable.id, campaign.id), eq(campaignsTable.status, "scheduled")));
  }

  await materializeRecipients(db, {
    id: campaign.id,
    orgId: campaign.orgId,
    channel: campaign.channel,
    audience: campaign.audience ?? {},
  });

  const settings = await loadSenderSettings(campaign.orgId);
  const channel = campaign.channel;

  // Provider / compliance preconditions. The send route refuses to start a
  // campaign without these; re-checked here in case config changed since.
  let blocker: string | null = null;
  if (channel === "email") {
    if (!isEmailConfigured()) blocker = "Email sending is not configured (RESEND_API_KEY)";
    else if (!senderIdentity(settings)) blocker = "No physical mailing address in campaign settings (CAN-SPAM)";
    else if (!unsubscribeLinksAvailable())
      blocker = "Unsubscribe links are not configured (PHI_HMAC_KEY / APP_BASE_URL)";
  } else if (!isSmsConfigured()) {
    blocker = "SMS sending is not configured (Twilio)";
  }
  if (blocker) {
    await failAllQueued(campaign.id, blocker);
    await finalize(campaign, now);
    logger.warn({ campaignId: campaign.id, blocker }, "Campaign send blocked");
    return;
  }

  const candidates = await db
    .select({
      recipientId: campaignRecipientsTable.id,
      toAddress: campaignRecipientsTable.toAddress,
      contactId: contactsTable.id,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      assignedAgentId: contactsTable.assignedAgentId,
      currentPlanType: contactsTable.currentPlanType,
      currentCarrierId: contactsTable.currentCarrierId,
      planYear: contactsTable.planYear,
    })
    .from(campaignRecipientsTable)
    .innerJoin(contactsTable, eq(contactsTable.id, campaignRecipientsTable.contactId))
    .where(
      and(
        eq(campaignRecipientsTable.campaignId, campaign.id),
        eq(campaignRecipientsTable.status, "queued"),
        isNull(campaignRecipientsTable.claimedAt),
      ),
    )
    .orderBy(campaignRecipientsTable.createdAt, campaignRecipientsTable.id)
    .limit(MAX_PER_RUN);

  const agentNames = new Map<string, string>();
  const carrierNames = new Map<string, string>();
  const agentIds = [...new Set(candidates.map((c) => c.assignedAgentId).filter((x): x is string => !!x))];
  const carrierIds = [...new Set(candidates.map((c) => c.currentCarrierId).filter((x): x is string => !!x))];
  if (agentIds.length) {
    const rows = await db
      .select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName })
      .from(agentsTable)
      .where(and(inArray(agentsTable.id, agentIds), eq(agentsTable.orgId, campaign.orgId)));
    for (const a of rows) agentNames.set(a.id, `${a.firstName} ${a.lastName}`.trim());
  }
  if (carrierIds.length) {
    const rows = await db
      .select({ id: carriersTable.id, name: carriersTable.name })
      .from(carriersTable)
      .where(and(inArray(carriersTable.id, carrierIds), eq(carriersTable.orgId, campaign.orgId)));
    for (const c of rows) carrierNames.set(c.id, c.name);
  }

  const sender = senderIdentity(settings);
  const fromEmail = process.env.EMAIL_FROM_ADDRESS ?? "noreply@mediflow.app";
  const fromHeader = `"${safeDisplayName(settings.agencyName)}" <${fromEmail}>`;
  const statusCallback = channel === "sms" ? twilioStatusCallbackUrl() : undefined;
  const delay = throttleMs(channel);

  let processed = 0;
  let deferredUntil: Date | null = null;

  for (const c of candidates) {
    // Stop promptly if an admin cancels mid-send.
    if (processed > 0 && processed % 25 === 0) {
      const [cur] = await db
        .select({ status: campaignsTable.status })
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id))
        .limit(1);
      if (cur?.status === "cancelled") {
        logger.info({ campaignId: campaign.id }, "Campaign cancelled mid-send — stopping");
        await refreshCampaignCounts(campaign.id);
        return;
      }
    }

    // Send-time eligibility: the shared consumer outreach gate.
    const consumer: ConsumerContext = { orgId: campaign.orgId, contactId: c.contactId, automated: true };
    let address = "";
    let unsubscribeBase: string | null = null;
    let skip: { status: "skipped_opt_out" | "failed"; error: string } | null = null;
    if (channel === "email") {
      const decision = await evaluateConsumerEmail(consumer);
      if (decision.action === "block") skip = skipFor(decision.reason);
      else if (!decision.unsubscribeUrl) skip = skipFor("unsubscribe_unavailable");
      else {
        address = decision.to.trim();
        unsubscribeBase = decision.unsubscribeUrl;
      }
    } else {
      const decision = await evaluateConsumerSms(consumer, now());
      if (decision.action === "block") skip = skipFor(decision.reason);
      else if (decision.action === "defer") {
        // Outside the recipient's legal texting window: stays queued.
        if (!deferredUntil || decision.until < deferredUntil) deferredUntil = decision.until;
        continue;
      } else address = decision.to.trim();
    }
    if (skip) {
      await db
        .update(campaignRecipientsTable)
        .set({ status: skip.status, error: skip.error, claimedAt: now() })
        .where(
          and(
            eq(campaignRecipientsTable.id, c.recipientId),
            eq(campaignRecipientsTable.status, "queued"),
            isNull(campaignRecipientsTable.claimedAt),
          ),
        );
      continue;
    }

    // Claim — the per-recipient idempotency guard.
    const claimed = await db
      .update(campaignRecipientsTable)
      .set({ claimedAt: now() })
      .where(
        and(
          eq(campaignRecipientsTable.id, c.recipientId),
          eq(campaignRecipientsTable.status, "queued"),
          isNull(campaignRecipientsTable.claimedAt),
        ),
      )
      .returning({ id: campaignRecipientsTable.id });
    if (claimed.length === 0) continue;

    const ctx: MergeContext = {
      first_name: c.firstName ?? "",
      last_name: c.lastName ?? "",
      agency_name: settings.agencyName,
      agent_name: c.assignedAgentId ? (agentNames.get(c.assignedAgentId) ?? "") : "",
      plan_type: c.currentPlanType ?? "",
      carrier: c.currentCarrierId ? (carrierNames.get(c.currentCarrierId) ?? "") : "",
      plan_year: c.planYear ? String(c.planYear) : "",
    };

    let ok = false;
    let providerId: string | null = null;
    let error: string | null = null;
    let timelineBody = "";
    let subject: string | null = null;

    try {
      if (channel === "email") {
        const href = campaignUnsubscribeUrl(unsubscribeBase!, c.recipientId);
        subject = applyMergeFields(campaign.subject ?? "", ctx, { html: false });
        const bodyHtml = applyMergeFields(campaign.body ?? "", ctx, { html: true });
        const html = wrapEmailHtml(bodyHtml, emailFooterHtml(sender!, href));
        const text = htmlToText(bodyHtml) + emailFooterText(sender!, href);
        timelineBody = htmlToText(bodyHtml);
        const res = await sendEmail({
          to: { email: address },
          from: fromHeader,
          subject,
          html,
          text,
          replyTo: settings.replyToEmail ?? undefined,
          headers: unsubscribeHeaders(href),
          tags: { campaign_id: campaign.id, recipient_id: c.recipientId },
        });
        if (res.success) {
          ok = true;
          providerId = res.id;
        } else error = res.error;
      } else {
        const [prior] = await db
          .select({ id: campaignRecipientsTable.id })
          .from(campaignRecipientsTable)
          .where(
            and(
              eq(campaignRecipientsTable.orgId, campaign.orgId),
              eq(campaignRecipientsTable.contactId, c.contactId),
              eq(campaignRecipientsTable.channel, "sms"),
              isNotNull(campaignRecipientsTable.sentAt),
              ne(campaignRecipientsTable.id, c.recipientId),
            ),
          )
          .limit(1);
        const merged = applyMergeFields(campaign.body ?? "", ctx, { html: false });
        const body = prior ? merged : withStopLine(merged);
        timelineBody = body;
        const res = await sendSms({ to: address, body, statusCallback });
        if (res.success) {
          ok = true;
          providerId = res.sid;
        } else error = res.error;
      }
    } catch (err) {
      error = (err as Error).message;
    }

    let messageId: string | null = null;
    try {
      messageId = await recordOutboundMessage({
        orgId: campaign.orgId,
        contactId: c.contactId,
        channel,
        subject,
        body: timelineBody,
        toAddress: address,
        fromAddress: channel === "email" ? fromEmail : (process.env.TWILIO_FROM_NUMBER ?? null),
        status: ok ? "sent" : "failed",
        providerMessageId: providerId,
      });
    } catch (err) {
      logger.error({ err, campaignId: campaign.id }, "Failed to record campaign message on timeline");
    }

    await db
      .update(campaignRecipientsTable)
      .set(
        ok
          ? { status: "sent", providerMessageId: providerId, messageId, sentAt: now(), error: null }
          : { status: "failed", messageId, error: (error ?? "Send failed").slice(0, 500) },
      )
      .where(eq(campaignRecipientsTable.id, c.recipientId));

    processed++;
    if (delay > 0) await sleep(delay);
  }

  await refreshCampaignCounts(campaign.id);

  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(campaignRecipientsTable)
    .where(
      and(
        eq(campaignRecipientsTable.campaignId, campaign.id),
        eq(campaignRecipientsTable.status, "queued"),
        isNull(campaignRecipientsTable.claimedAt),
      ),
    );

  if (Number(remaining) > 0) {
    const startAfter =
      processed > 0 || !deferredUntil ? new Date(now().getTime() + 1_000) : deferredUntil;
    await enqueue(JOB_NAMES.CAMPAIGN_SEND, data, { startAfter });
    logger.info({ campaignId: campaign.id, processed, remaining, startAfter }, "Campaign send continues");
    return;
  }

  await finalize(campaign, now);
}

async function finalize(campaign: Campaign, now: () => Date): Promise<void> {
  // Claimed rows still `queued` belong to a run that is either mid-send
  // (recent claim) or crashed (old claim). Close out the crashed ones without
  // re-sending; if any are recent, come back later.
  const cutoff = new Date(now().getTime() - STRANDED_CLAIM_MS);
  await db
    .update(campaignRecipientsTable)
    .set({ status: "failed", error: "Send interrupted; not retried to avoid a duplicate message" })
    .where(
      and(
        eq(campaignRecipientsTable.campaignId, campaign.id),
        eq(campaignRecipientsTable.status, "queued"),
        isNotNull(campaignRecipientsTable.claimedAt),
        lt(campaignRecipientsTable.claimedAt, cutoff),
      ),
    );
  const [{ inFlight }] = await db
    .select({ inFlight: sql<number>`count(*)::int` })
    .from(campaignRecipientsTable)
    .where(and(eq(campaignRecipientsTable.campaignId, campaign.id), eq(campaignRecipientsTable.status, "queued")));
  if (Number(inFlight) > 0) {
    await enqueue(
      JOB_NAMES.CAMPAIGN_SEND,
      { campaignId: campaign.id, orgId: campaign.orgId },
      { startAfter: new Date(now().getTime() + STRANDED_CLAIM_MS) },
    );
    return;
  }
  await db
    .update(campaignsTable)
    .set({ status: "sent", sentAt: now() })
    .where(and(eq(campaignsTable.id, campaign.id), eq(campaignsTable.status, "sending")));
  await refreshCampaignCounts(campaign.id);
  logger.info({ campaignId: campaign.id }, "Campaign send complete");
}
