/**
 * POST /webhooks/stripe — the only path that may change an org's entitlements.
 *
 * Three properties this handler must hold, in order of severity:
 *
 *  1. **Signature verified before anything else.** The body is parsed from the
 *     raw bytes captured in `app.ts` and checked against
 *     `STRIPE_WEBHOOK_SECRET`. An unsigned or mis-signed request is rejected
 *     before a single field is read — otherwise anyone who can reach this URL
 *     can grant themselves the Agency plan.
 *
 *  2. **Idempotent.** Stripe delivers at-least-once and retries on any non-2xx.
 *     Every event id is inserted into `billing_events` first; a duplicate
 *     collides on the primary key and returns 200 without re-applying effects.
 *
 *  3. **Attributable to exactly one tenant.** The org is resolved from
 *     metadata written at customer/subscription creation, falling back to the
 *     `stripe_customer_id` already on the subscription row. An event we cannot
 *     attribute is logged and acknowledged — never applied to a guessed org.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type Stripe from "stripe";
import { db, subscriptionsTable, billingEventsTable } from "@workspace/db";

import { getStripe, webhookSecret } from "../lib/billing/stripe";
import { tierForStripePrice, PLANS, type PlanTier } from "../lib/billing/plans";
import {
  invalidateEntitlements,
  syncOrgPlanTier,
} from "../lib/billing/entitlements";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Subscription events we act on. Anything else is recorded and ignored. */
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
]);

type SubscriptionStatus =
  (typeof subscriptionsTable.$inferInsert)["status"];

/** Maps Stripe's status vocabulary onto our enum, defensively. */
function mapStatus(status: string): SubscriptionStatus {
  const known: SubscriptionStatus[] = [
    "trialing",
    "active",
    "past_due",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "unpaid",
    "paused",
  ];
  return (known as string[]).includes(status)
    ? (status as SubscriptionStatus)
    : "none";
}

function toDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

/**
 * Resolves the tenant an event belongs to.
 *
 * Prefers explicit metadata (written when the customer and subscription were
 * created); falls back to the customer id already recorded against an org.
 * Returns null rather than guessing.
 */
async function resolveOrgId(
  metadata: Stripe.Metadata | null | undefined,
  customerId: string | null,
): Promise<string | null> {
  const fromMetadata = metadata?.orgId;
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
    return fromMetadata;
  }
  if (!customerId) return null;

  const [row] = await db
    .select({ orgId: subscriptionsTable.orgId })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.stripeCustomerId, customerId))
    .limit(1);
  return row?.orgId ?? null;
}

function customerIdOf(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/** Applies a Stripe subscription object to our local projection. */
async function applySubscription(
  orgId: string,
  subscription: Stripe.Subscription,
): Promise<void> {
  const item = subscription.items?.data?.[0];
  const priceId = item?.price?.id ?? null;

  // Tier comes from the price the customer is actually being billed for.
  // Subscription metadata is a hint only — the price is what Stripe charges.
  const tier: PlanTier =
    (priceId ? tierForStripePrice(priceId) : undefined) ??
    ((subscription.metadata?.tier as PlanTier | undefined) ?? "starter");

  const status = mapStatus(subscription.status);
  const active = status === "active" || status === "trialing";

  // Stripe moved period boundaries onto the subscription item in recent API
  // versions; fall back to the subscription-level field for older payloads.
  const periodEnd =
    toDate(item?.current_period_end) ??
    toDate(
      (subscription as unknown as { current_period_end?: number })
        .current_period_end,
    );

  const values = {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: customerIdOf(subscription.customer),
    stripePriceId: priceId,
    planTier: tier,
    status,
    seats: item?.quantity ?? PLANS[tier].includedSeats,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    trialEndsAt: toDate(subscription.trial_end),
  };

  await db
    .insert(subscriptionsTable)
    .values({ id: randomUUID(), orgId, ...values })
    .onConflictDoUpdate({
      target: subscriptionsTable.orgId,
      set: { ...values, updatedAt: new Date() },
    });

  // Keep the denormalized `organizations.plan_tier` honest. A subscription
  // that is not entitling drops the org to starter rather than leaving a paid
  // tier stamped on an unpaid account.
  await syncOrgPlanTier(orgId, active ? tier : "starter");
  invalidateEntitlements(orgId);

  logger.info(
    { orgId, tier, status, subscriptionId: subscription.id },
    "Subscription projection updated",
  );
}

router.post(
  "/webhooks/stripe",
  async (req: Request, res: Response): Promise<void> => {
    const stripe = getStripe();
    const secret = webhookSecret();

    if (!stripe || !secret) {
      // Unconfigured deployment. 503 (not 400) so Stripe retries after the
      // operator finishes wiring the environment, rather than dropping events.
      res.status(503).json({ error: "Stripe billing is not configured" });
      return;
    }

    const signature = req.headers["stripe-signature"];
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (typeof signature !== "string" || !rawBody) {
      res.status(400).json({ error: "Missing Stripe signature or raw body" });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      // Do not log the body — an unverified payload is attacker-controlled.
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "Rejected Stripe webhook with an invalid signature",
      );
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // Idempotency gate: claim the event id before applying any side effect.
    const claimed = await db
      .insert(billingEventsTable)
      .values({
        id: event.id,
        eventType: event.type,
        payload: { type: event.type, created: event.created },
      })
      .onConflictDoNothing({ target: billingEventsTable.id })
      .returning({ id: billingEventsTable.id });

    if (claimed.length === 0) {
      logger.debug({ eventId: event.id }, "Duplicate Stripe webhook ignored");
      res.json({ received: true, duplicate: true });
      return;
    }

    if (!HANDLED.has(event.type)) {
      res.json({ received: true, handled: false });
      return;
    }

    try {
      let orgId: string | null = null;

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const customerId = customerIdOf(session.customer);
          orgId =
            session.client_reference_id ??
            (await resolveOrgId(session.metadata, customerId));

          if (orgId && session.subscription) {
            const subId =
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription.id;
            // Re-fetch rather than trusting the thin object on the session, so
            // the projection is built from the full, current subscription.
            const full = await stripe.subscriptions.retrieve(subId);
            await applySubscription(orgId, full);
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          orgId = await resolveOrgId(
            subscription.metadata,
            customerIdOf(subscription.customer),
          );
          if (!orgId) break;

          if (event.type === "customer.subscription.deleted") {
            await db
              .update(subscriptionsTable)
              .set({
                status: "canceled",
                planTier: "starter",
                cancelAtPeriodEnd: false,
                updatedAt: new Date(),
              })
              .where(eq(subscriptionsTable.orgId, orgId));
            await syncOrgPlanTier(orgId, "starter");
            invalidateEntitlements(orgId);
            logger.info({ orgId }, "Subscription canceled — dropped to starter");
          } else {
            await applySubscription(orgId, subscription);
          }
          break;
        }

        case "invoice.paid":
        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = customerIdOf(invoice.customer);
          orgId = await resolveOrgId(invoice.metadata, customerId);
          if (!orgId) break;

          // Stripe's own subscription.updated event carries the authoritative
          // status transition; this branch exists to invalidate the cache
          // promptly and leave an attributable audit row.
          invalidateEntitlements(orgId);
          logger.info(
            { orgId, eventType: event.type, invoiceId: invoice.id },
            "Billing invoice event recorded",
          );
          break;
        }
      }

      if (orgId) {
        await db
          .update(billingEventsTable)
          .set({ orgId })
          .where(eq(billingEventsTable.id, event.id));
      } else {
        logger.warn(
          { eventId: event.id, eventType: event.type },
          "Stripe webhook could not be attributed to an org — acknowledged without applying",
        );
      }

      res.json({ received: true, handled: true });
    } catch (err) {
      // Release the idempotency claim so Stripe's retry can reprocess: a
      // claimed-but-failed event would otherwise be silently dropped forever.
      await db
        .delete(billingEventsTable)
        .where(eq(billingEventsTable.id, event.id));

      logger.error(
        { err, eventId: event.id, eventType: event.type },
        "Failed to process Stripe webhook",
      );
      res.status(500).json({ error: "Webhook processing failed" });
    }
  },
);

export default router;
