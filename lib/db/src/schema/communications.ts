import {
  pgTable,
  text,
  timestamp,
  boolean,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";
import { contactsTable } from "./crm";

export const channelEnum = pgEnum("channel", ["sms", "email"]);
export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);
export const messageStatusEnum = pgEnum("message_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
  "received",
]);

export const messageThreadsTable = pgTable("message_threads", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  contactId: text("contact_id")
    .notNull()
    .references(() => contactsTable.id, { onDelete: "cascade" }),
  channel: channelEnum("channel").notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type MessageThread = typeof messageThreadsTable.$inferSelect;

export const messagesTable = pgTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => messageThreadsTable.id, { onDelete: "cascade" }),
  direction: messageDirectionEnum("direction").notNull(),
  body: text("body"),
  subject: text("subject"),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  status: messageStatusEnum("status").notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  aiAssisted: boolean("ai_assisted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;

export const emailTemplatesTable = pgTable("email_templates", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  bodyText: text("body_text"),
  mergeFields: text("merge_fields").array(),
  category: text("category").notNull().default("general"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type EmailTemplate = typeof emailTemplatesTable.$inferSelect;

export const smsTemplatesTable = pgTable("sms_templates", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  body: text("body").notNull(),
  mergeFields: text("merge_fields").array(),
  category: text("category").notNull().default("general"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SmsTemplate = typeof smsTemplatesTable.$inferSelect;

export const optOutsTable = pgTable(
  "opt_outs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    phone: text("phone"),
    email: text("email"),
    channel: channelEnum("channel").notNull(),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Compliance audit-log dedup. Two concurrent STOP messages from the
    // same phone in the same org must collapse to a single opt_outs row
    // (matches migration 0013). The PK is a random UUID, so without this
    // index `onConflictDoNothing()` has no real conflict target. NULL
    // phone rows (e.g. email-channel opt-outs) are excluded by Postgres'
    // default NULLS-DISTINCT behavior, so this only enforces uniqueness
    // for SMS-style rows.
    uniqueIndex("opt_outs_org_phone_channel_unique").on(
      t.orgId,
      t.phone,
      t.channel,
    ),
  ],
);

export type OptOut = typeof optOutsTable.$inferSelect;
