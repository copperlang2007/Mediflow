/**
 * Billing — Stripe subscription state mirrored into Postgres.
 *
 * Stripe is the system of record for money; this schema is the local,
 * queryable projection the app enforces entitlements against. Every row is
 * written from a verified Stripe webhook (or an authenticated sync), never
 * from client input — the browser can ask to *start* a checkout, but it can
 * never assert what plan an org is on.
 *
 * `subscriptions` is one-row-per-org (org_id UNIQUE): an agency has exactly
 * one active plan. `billing_events` is the webhook idempotency ledger —
 * Stripe delivers at-least-once, so every event id is recorded before its
 * side effects are applied and a duplicate delivery is a no-op.
 */
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { organizationsTable } from "./core";

/** Plan tiers, ordered lowest → highest. Mirrors `organizations.plan_tier`. */
export const planTierEnum = pgEnum("plan_tier", [
  "starter",
  "growth",
  "agency",
]);

/**
 * Subscription lifecycle, mirroring Stripe's own status vocabulary plus a
 * local `none` for orgs that have never checked out.
 */
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "none",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .unique()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    planTier: planTierEnum("plan_tier").notNull().default("starter"),
    status: subscriptionStatusEnum("status").notNull().default("none"),
    /**
     * Logins purchased. A seat is one active `users` row — not an `agents`
     * row; see `api-server/src/lib/billing/seats.ts` for why those are
     * different populations. Enforced on invitation and on reactivation.
     */
    seats: integer("seats").notNull().default(3),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("subscriptions_stripe_customer_idx").on(table.stripeCustomerId),
    index("subscriptions_stripe_subscription_idx").on(
      table.stripeSubscriptionId,
    ),
  ],
);

export const insertSubscriptionSchema = createInsertSchema(
  subscriptionsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;

/**
 * Webhook idempotency ledger + billing audit trail.
 *
 * `id` is Stripe's own event id, so a replayed delivery collides on the
 * primary key and is discarded before any side effect runs.
 */
export const billingEventsTable = pgTable(
  "billing_events",
  {
    /** Stripe event id (evt_...). Primary key = idempotency guarantee. */
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => organizationsTable.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    /** Trimmed event payload — never the full object, never card data. */
    payload: jsonb("payload"),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("billing_events_org_processed_idx").on(
      table.orgId,
      table.processedAt,
    ),
  ],
);

export type BillingEvent = typeof billingEventsTable.$inferSelect;
