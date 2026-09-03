/**
 * Billing routes — subscription state, checkout, and the customer portal.
 *
 * The browser never asserts a plan. It can start a Stripe Checkout session or
 * open the Stripe billing portal; every actual change to what an org is
 * entitled to arrives back through the signed webhook in `webhooks.ts`.
 *
 *   GET  /billing/plans         — public plan catalog (auth'd, no secrets)
 *   GET  /billing/subscription  — this org's current subscription + usage
 *   POST /billing/checkout      — start a Stripe Checkout session
 *   POST /billing/portal        — open the Stripe customer portal
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, count } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  subscriptionsTable,
  organizationsTable,
  agentsTable,
  contactsTable,
} from "@workspace/db";

import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { getStripe, isBillingConfigured } from "../lib/billing/stripe";
import {
  PLANS,
  PLAN_TIERS,
  isPlanTier,
  stripePriceIdFor,
  type PlanTier,
} from "../lib/billing/plans";
import {
  getEntitlements,
  invalidateEntitlements,
} from "../lib/billing/entitlements";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function billingUnavailable(res: Response): void {
  res.status(503).json({
    error:
      "Billing is not configured on this deployment. Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* variables to enable checkout.",
    code: "billing_unconfigured",
  });
}

/**
 * Ensures a subscription row exists for the org and returns it.
 *
 * Orgs created before billing shipped (and any created while Stripe is
 * unconfigured) have no row; rather than special-casing a missing row at every
 * read site, we materialize a free-tier one on first touch.
 */
async function ensureSubscriptionRow(orgId: string) {
  const [existing] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.orgId, orgId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(subscriptionsTable)
    .values({
      id: randomUUID(),
      orgId,
      planTier: "starter",
      status: "none",
      seats: PLANS.starter.includedSeats,
    })
    .onConflictDoNothing({ target: subscriptionsTable.orgId })
    .returning();

  if (created) return created;

  // Lost the race with a concurrent request — re-read the winner's row.
  const [raced] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.orgId, orgId))
    .limit(1);
  return raced;
}

/**
 * GET /billing/plans
 *
 * The catalog the pricing UI renders. Includes which tiers are actually
 * purchasable on this deployment, so the UI can disable a buy button rather
 * than fail at checkout.
 */
router.get(
  "/billing/plans",
  requireAuth,
  requirePermission("billing", "read"),
  async (_req: Request, res: Response): Promise<void> => {
    res.json({
      billingConfigured: isBillingConfigured(),
      plans: PLAN_TIERS.map((tier) => ({
        ...PLANS[tier],
        purchasable: tier === "starter" || Boolean(stripePriceIdFor(tier)),
      })),
    });
  },
);

/**
 * GET /billing/subscription
 *
 * Current entitlements plus live usage, so the UI can show "12 of 15 agents"
 * without a second round trip.
 */
router.get(
  "/billing/subscription",
  requireAuth,
  requirePermission("billing", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const [subscription, entitlements, agentRows, contactRows] =
      await Promise.all([
        ensureSubscriptionRow(authReq.orgId),
        getEntitlements(authReq.orgId),
        db
          .select({ n: count() })
          .from(agentsTable)
          .where(eq(agentsTable.orgId, authReq.orgId)),
        db
          .select({ n: count() })
          .from(contactsTable)
          .where(eq(contactsTable.orgId, authReq.orgId)),
      ]);

    res.json({
      tier: entitlements.tier,
      plan: entitlements.plan,
      status: entitlements.status,
      seats: entitlements.seats,
      billingConfigured: entitlements.billingConfigured,
      unbilledGrant: entitlements.unbilledGrant,
      currentPeriodEnd: entitlements.currentPeriodEnd,
      cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
      hasPaymentMethod: Boolean(subscription?.stripeCustomerId),
      usage: {
        agents: agentRows[0]?.n ?? 0,
        contacts: contactRows[0]?.n ?? 0,
      },
    });
  },
);

const CheckoutSchema = z.object({
  tier: z.string().refine(isPlanTier, "Unknown plan tier"),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

/**
 * POST /billing/checkout
 *
 * Returns a Stripe Checkout URL for the requested tier. The org's Stripe
 * customer is created on first checkout and reused thereafter, so a returning
 * buyer keeps one customer record and one invoice history.
 */
router.post(
  "/billing/checkout",
  requireAuth,
  requirePermission("billing", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const stripe = getStripe();
    if (!stripe) {
      billingUnavailable(res);
      return;
    }

    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const tier = parsed.data.tier as PlanTier;
    if (tier === "starter") {
      res.status(400).json({
        error: "The Starter plan is free — no checkout is required.",
        code: "no_checkout_for_free_tier",
      });
      return;
    }

    const priceId = stripePriceIdFor(tier);
    if (!priceId) {
      res.status(503).json({
        error: `No Stripe price is configured for the ${PLANS[tier].name} plan. Set STRIPE_PRICE_${tier.toUpperCase()}.`,
        code: "price_not_configured",
      });
      return;
    }

    const [org] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, authReq.orgId))
      .limit(1);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const subscription = await ensureSubscriptionRow(authReq.orgId);

    let customerId = subscription?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: org.name,
        // `orgId` is the join key every webhook uses to find its way back to
        // a tenant. Without it a webhook cannot be attributed safely.
        metadata: { orgId: org.id, orgSlug: org.slug },
      });
      customerId = customer.id;
      await db
        .update(subscriptionsTable)
        .set({ stripeCustomerId: customerId })
        .where(eq(subscriptionsTable.orgId, authReq.orgId));
    }

    const appUrl = (
      process.env.APP_PUBLIC_URL ?? process.env.ALLOWED_ORIGIN ?? ""
    ).replace(/\/+$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: org.id,
      subscription_data: { metadata: { orgId: org.id, tier } },
      metadata: { orgId: org.id, tier },
      allow_promotion_codes: true,
      success_url:
        parsed.data.successUrl ??
        `${appUrl}/settings/billing?checkout=success`,
      cancel_url:
        parsed.data.cancelUrl ?? `${appUrl}/settings/billing?checkout=canceled`,
    });

    logger.info(
      { orgId: org.id, tier, sessionId: session.id },
      "Stripe checkout session created",
    );

    res.json({ url: session.url, sessionId: session.id });
  },
);

/**
 * POST /billing/portal
 *
 * Opens Stripe's hosted billing portal, where the customer manages their card,
 * invoices, and cancellation. Keeping this in Stripe's UI means no card data
 * ever reaches this application.
 */
router.post(
  "/billing/portal",
  requireAuth,
  requirePermission("billing", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const stripe = getStripe();
    if (!stripe) {
      billingUnavailable(res);
      return;
    }

    const subscription = await ensureSubscriptionRow(authReq.orgId);
    if (!subscription?.stripeCustomerId) {
      res.status(409).json({
        error:
          "This organization has no billing account yet. Start a subscription first.",
        code: "no_stripe_customer",
      });
      return;
    }

    const appUrl = (
      process.env.APP_PUBLIC_URL ?? process.env.ALLOWED_ORIGIN ?? ""
    ).replace(/\/+$/, "");

    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${appUrl}/settings/billing`,
    });

    invalidateEntitlements(authReq.orgId);
    res.json({ url: session.url });
  },
);

export default router;
