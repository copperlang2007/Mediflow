/**
 * Omnichannel marketing campaigns (email + SMS).
 *
 * A `campaigns` row is one broadcast: a channel, content (a saved template or
 * inline subject/body), an audience filter over contacts, and a lifecycle
 * draft → scheduled → sending → sent (or cancelled).
 *
 * `campaign_recipients` is the per-contact fan-out ledger. The unique
 * (campaign_id, contact_id) key makes materializing an audience idempotent,
 * and `claimed_at` is the per-recipient "a worker has taken this one" marker
 * that stops a retried job from sending the same message twice. Opted-out
 * contacts are recorded up front as `skipped_opt_out` so the campaign keeps a
 * provable record of who was deliberately NOT messaged.
 *
 * `campaign_settings` holds the per-org sender identity that CAN-SPAM
 * requires in every commercial email (agency name + a valid physical postal
 * address) and the fallback time zone for TCPA quiet hours.
 *
 * `campaign_events` is the idempotency ledger for provider callbacks
 * (Resend webhooks keyed by svix-id; Twilio status callbacks keyed by
 * MessageSid + status). Payloads are not stored.
 *
 * Counts on `campaigns` are a cache recomputed from `campaign_recipients`;
 * the recipients table is the source of truth.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable, usersTable } from "./core";
import { contactsTable } from "./crm";
import {
  channelEnum,
  emailTemplatesTable,
  smsTemplatesTable,
  messagesTable,
} from "./communications";

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
]);

export const campaignRecipientStatusEnum = pgEnum("campaign_recipient_status", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "skipped_opt_out",
]);

/**
 * Audience filter stored on a campaign. Every key is optional; an empty
 * object means "every contact in the org who can be reached on the channel".
 * Health conditions and race are deliberately NOT filterable.
 */
export type CampaignAudience = {
  statuses?: string[];
  planTypes?: string[];
  carrierIds?: string[];
  states?: string[];
  sources?: string[];
  tags?: string[];
  birthdayMonth?: number;
};

export const campaignsTable = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    name: text("name").notNull(),
    emailTemplateId: text("email_template_id").references(
      () => emailTemplatesTable.id,
      { onDelete: "set null" },
    ),
    smsTemplateId: text("sms_template_id").references(
      () => smsTemplatesTable.id,
      { onDelete: "set null" },
    ),
    /** Email subject (inline, or copied from the template at send time). */
    subject: text("subject"),
    /** Email HTML or SMS text (inline, or copied from the template at send time). */
    body: text("body"),
    audience: jsonb("audience").$type<CampaignAudience>().notNull().default({}),
    status: campaignStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    recipientCount: integer("recipient_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    deliveredCount: integer("delivered_count").notNull().default(0),
    openedCount: integer("opened_count").notNull().default(0),
    clickedCount: integer("clicked_count").notNull().default(0),
    bouncedCount: integer("bounced_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    unsubscribedCount: integer("unsubscribed_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("campaigns_org_channel_created_idx").on(t.orgId, t.channel, t.createdAt),
    index("campaigns_org_status_idx").on(t.orgId, t.status),
  ],
);

export type Campaign = typeof campaignsTable.$inferSelect;

export const campaignRecipientsTable = pgTable(
  "campaign_recipients",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaignsTable.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contactsTable.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    toAddress: text("to_address"),
    status: campaignRecipientStatusEnum("status").notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    messageId: text("message_id").references(() => messagesTable.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("campaign_recipients_campaign_contact_key").on(
      t.campaignId,
      t.contactId,
    ),
    index("campaign_recipients_campaign_status_idx").on(t.campaignId, t.status),
    index("campaign_recipients_org_contact_idx").on(t.orgId, t.contactId),
    index("campaign_recipients_provider_msg_idx")
      .on(t.providerMessageId)
      .where(sql`${t.providerMessageId} IS NOT NULL`),
  ],
);

export type CampaignRecipient = typeof campaignRecipientsTable.$inferSelect;

export const campaignSettingsTable = pgTable("campaign_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** "From" name and the agency name printed in the email footer. */
  senderName: text("sender_name"),
  /** CAN-SPAM: a valid physical postal address, printed in every email. */
  physicalAddress: text("physical_address"),
  replyToEmail: text("reply_to_email"),
  /** IANA zone used for SMS quiet hours when a contact has no state on file. */
  defaultTimeZone: text("default_time_zone").notNull().default("America/New_York"),
  updatedBy: text("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CampaignSettings = typeof campaignSettingsTable.$inferSelect;

export const campaignEventsTable = pgTable(
  "campaign_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    eventType: text("event_type").notNull(),
    recipientId: text("recipient_id").references(
      () => campaignRecipientsTable.id,
      { onDelete: "set null" },
    ),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_events_provider_external_key").on(
      t.provider,
      t.externalId,
    ),
    index("campaign_events_received_idx").on(t.receivedAt),
  ],
);

export type CampaignEvent = typeof campaignEventsTable.$inferSelect;
