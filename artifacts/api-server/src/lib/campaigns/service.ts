/**
 * Shared campaign data operations used by the routes, the send worker, the
 * provider webhooks and the shared email unsubscribe endpoint
 * (routes/unsubscribe.ts).
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  auditLogTable,
  campaignRecipientsTable,
  campaignSettingsTable,
  campaignsTable,
  contactsTable,
  messageThreadsTable,
  messagesTable,
  optOutsTable,
  organizationsTable,
} from "@workspace/db";
import { logger } from "../logger";
import type { SenderIdentity } from "./render";
import { unsubscribeUrl } from "../compliance/unsubscribe";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;

export interface OrgSenderSettings {
  agencyName: string;
  physicalAddress: string | null;
  replyToEmail: string | null;
  defaultTimeZone: string;
}

export async function loadSenderSettings(orgId: string): Promise<OrgSenderSettings> {
  const [org] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const [s] = await db
    .select()
    .from(campaignSettingsTable)
    .where(eq(campaignSettingsTable.orgId, orgId))
    .limit(1);
  return {
    agencyName: s?.senderName?.trim() || org?.name || "Your agency",
    physicalAddress: s?.physicalAddress?.trim() || null,
    replyToEmail: s?.replyToEmail?.trim() || null,
    defaultTimeZone: s?.defaultTimeZone || "America/New_York",
  };
}

export function senderIdentity(s: OrgSenderSettings): SenderIdentity | null {
  if (!s.physicalAddress) return null;
  return { agencyName: s.agencyName, physicalAddress: s.physicalAddress };
}

/** Configured public base URL (APP_BASE_URL) for provider callbacks, or null. */
export function configuredPublicBaseUrl(): string | null {
  const raw = process.env.APP_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * True when this deployment can build the shared CAN-SPAM unsubscribe link
 * (lib/compliance/unsubscribe.ts: PHI_HMAC_KEY + APP_BASE_URL in production).
 */
export function unsubscribeLinksAvailable(): boolean {
  return unsubscribeUrl({ orgId: "config-probe", contactId: "config-probe" }) !== null;
}

/**
 * The shared unsubscribe link for one campaign email: the signed org+contact
 * link, plus `r` so routes/unsubscribe.ts credits the campaign.
 */
export function campaignUnsubscribeUrl(base: string, recipientId: string): string {
  return `${base}&r=${encodeURIComponent(recipientId)}`;
}

/** Recompute the counts cache on `campaigns` from `campaign_recipients`. */
export async function refreshCampaignCounts(campaignId: string, conn: Db = db): Promise<void> {
  const r = campaignRecipientsTable;
  const [row] = await conn
    .select({
      total: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${r.sentAt} IS NOT NULL)::int`,
      delivered: sql<number>`count(*) FILTER (WHERE ${r.deliveredAt} IS NOT NULL)::int`,
      opened: sql<number>`count(*) FILTER (WHERE ${r.openedAt} IS NOT NULL)::int`,
      clicked: sql<number>`count(*) FILTER (WHERE ${r.clickedAt} IS NOT NULL)::int`,
      bounced: sql<number>`count(*) FILTER (WHERE ${r.status} = 'bounced')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${r.status} = 'failed')::int`,
      skipped: sql<number>`count(*) FILTER (WHERE ${r.status} = 'skipped_opt_out')::int`,
      unsubscribed: sql<number>`count(*) FILTER (WHERE ${r.unsubscribedAt} IS NOT NULL)::int`,
    })
    .from(r)
    .where(eq(r.campaignId, campaignId));
  await conn
    .update(campaignsTable)
    .set({
      recipientCount: Number(row?.total ?? 0),
      sentCount: Number(row?.sent ?? 0),
      deliveredCount: Number(row?.delivered ?? 0),
      openedCount: Number(row?.opened ?? 0),
      clickedCount: Number(row?.clicked ?? 0),
      bouncedCount: Number(row?.bounced ?? 0),
      failedCount: Number(row?.failed ?? 0),
      skippedCount: Number(row?.skipped ?? 0),
      unsubscribedCount: Number(row?.unsubscribed ?? 0),
    })
    .where(eq(campaignsTable.id, campaignId));
}

/**
 * Write an outbound row into the contact's message thread (find-or-create by
 * contact + channel) so the campaign message shows on the contact timeline.
 */
export async function recordOutboundMessage(opts: {
  orgId: string;
  contactId: string;
  channel: "email" | "sms";
  subject: string | null;
  body: string;
  toAddress: string;
  fromAddress: string | null;
  status: "sent" | "failed";
  providerMessageId: string | null;
}): Promise<string> {
  return db.transaction(async (tx) => {
    let [thread] = await tx
      .select({ id: messageThreadsTable.id })
      .from(messageThreadsTable)
      .where(
        and(
          eq(messageThreadsTable.contactId, opts.contactId),
          eq(messageThreadsTable.orgId, opts.orgId),
          eq(messageThreadsTable.channel, opts.channel),
        ),
      )
      .limit(1);
    const now = new Date();
    if (!thread) {
      [thread] = await tx
        .insert(messageThreadsTable)
        .values({
          id: randomUUID(),
          orgId: opts.orgId,
          contactId: opts.contactId,
          channel: opts.channel,
          lastMessageAt: now,
        })
        .returning({ id: messageThreadsTable.id });
    } else {
      await tx
        .update(messageThreadsTable)
        .set({ lastMessageAt: now })
        .where(eq(messageThreadsTable.id, thread.id));
    }
    const id = randomUUID();
    await tx
      .insert(messagesTable)
      .values({
        id,
        threadId: thread!.id,
        direction: "outbound",
        body: opts.body,
        subject: opts.subject,
        fromAddress: opts.fromAddress,
        toAddress: opts.toAddress,
        status: opts.status,
        providerMessageId: opts.providerMessageId,
        sentAt: opts.status === "sent" ? now : null,
      })
      .onConflictDoNothing({
        target: messagesTable.providerMessageId,
        where: isNotNull(messagesTable.providerMessageId),
      });
    return id;
  });
}

/**
 * Attribute an email unsubscribe to the campaign email that carried the link.
 *
 * The unsubscribe itself (contact flag, `opt_outs` row, audit entry) is done
 * by the shared CAN-SPAM endpoint (routes/unsubscribe.ts) from its signed
 * org+contact token. Campaign links add the recipient row id as `r` so the
 * campaign's "unsubscribed" count stays accurate. `r` is not signed, so it is
 * only honoured for a recipient row belonging to the contact the signed token
 * names — it can pick which of that contact's own campaign emails is
 * credited, nothing else. Idempotent.
 */
export async function attributeCampaignUnsubscribe(opts: {
  orgId: string;
  contactId: string;
  recipientId: string;
}): Promise<void> {
  const [rec] = await db
    .update(campaignRecipientsTable)
    .set({ unsubscribedAt: new Date() })
    .where(
      and(
        eq(campaignRecipientsTable.id, opts.recipientId),
        eq(campaignRecipientsTable.orgId, opts.orgId),
        eq(campaignRecipientsTable.contactId, opts.contactId),
        sql`${campaignRecipientsTable.unsubscribedAt} IS NULL`,
      ),
    )
    .returning({ campaignId: campaignRecipientsTable.campaignId });
  if (rec) await refreshCampaignCounts(rec.campaignId);
}

/**
 * A spam complaint reported by the email provider (Resend webhook) is treated
 * as an unsubscribe (CAN-SPAM best practice): flag the contact, add the
 * address to the org's email suppression list (`opt_outs`, source
 * 'complaint'), stamp the campaign recipient and write an audit entry.
 * Idempotent. Link / one-click unsubscribes go through routes/unsubscribe.ts.
 */
export async function applyEmailComplaint(opts: {
  orgId: string;
  contactId: string;
  recipientId?: string | null;
}): Promise<void> {
  const [contact] = await db
    .select({ id: contactsTable.id, email: contactsTable.email, optOutEmail: contactsTable.optOutEmail })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, opts.contactId), eq(contactsTable.orgId, opts.orgId)))
    .limit(1);
  if (!contact) return;

  const now = new Date();
  let campaignId: string | null = null;
  await db.transaction(async (tx) => {
    await tx
      .update(contactsTable)
      .set({ optOutEmail: true })
      .where(and(eq(contactsTable.id, contact.id), eq(contactsTable.orgId, opts.orgId)));

    const email = contact.email?.trim().toLowerCase();
    if (email) {
      const [existing] = await tx
        .select({ id: optOutsTable.id })
        .from(optOutsTable)
        .where(
          and(
            eq(optOutsTable.orgId, opts.orgId),
            eq(optOutsTable.channel, "email"),
            sql`lower(${optOutsTable.email}) = ${email}`,
          ),
        )
        .limit(1);
      if (!existing) {
        await tx.insert(optOutsTable).values({
          id: randomUUID(),
          orgId: opts.orgId,
          email,
          channel: "email",
          source: "complaint",
        });
      }
    }

    if (opts.recipientId) {
      const [rec] = await tx
        .update(campaignRecipientsTable)
        .set({ unsubscribedAt: now })
        .where(
          and(
            eq(campaignRecipientsTable.id, opts.recipientId),
            eq(campaignRecipientsTable.orgId, opts.orgId),
            sql`${campaignRecipientsTable.unsubscribedAt} IS NULL`,
          ),
        )
        .returning({ campaignId: campaignRecipientsTable.campaignId });
      campaignId = rec?.campaignId ?? null;
    }

    if (!contact.optOutEmail) {
      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: opts.orgId,
        userId: null,
        userRole: null,
        action: "email_unsubscribe",
        resourceType: "contact",
        resourceId: contact.id,
        changes: { optOutEmail: true, via: "complaint", recipientId: opts.recipientId ?? null },
      });
    }
  });
  if (campaignId) await refreshCampaignCounts(campaignId);
  logger.info({ orgId: opts.orgId }, "Email complaint applied as unsubscribe");
}
