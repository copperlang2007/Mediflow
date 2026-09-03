# 1. Stripe billing and plan enforcement

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

`organizations.plan_tier` had existed since the first migration, defaulting to
`"starter"`. Nothing read it. There was no billing route among the 48 route
modules, no Stripe dependency, and no billing UI. Every deployment was
effectively unlimited and free, and there was no mechanism by which the product
could take money.

This was the single largest gap between the codebase and revenue. Everything
else needed to charge for the product already existed: authentication,
organizations, roles, and a working application.

## Decision

Stripe Checkout and the Stripe billing portal, with a local projection of
subscription state in Postgres and enforcement in application middleware.

Three tiers — Starter (free, 3 agents / 250 contacts), Growth ($297/mo, 15
agents / 5,000 contacts, commission reconciliation + e-sign + AI), and Agency
($997/mo, unlimited, plus voice, API, and SSO).

Structure:

- `lib/billing/plans.ts` — the catalog. Limits and display copy in one place so
  the pricing page and the enforcement code cannot disagree.
- `lib/billing/entitlements.ts` — resolves what an org may do, 30s cached,
  invalidated on every webhook.
- `middlewares/requirePlan.ts` — `enforceCapacity` / `enforceFeature`, applied
  alongside (never merged into) `requirePermission`.
- `routes/billing.ts` — catalog, subscription status, checkout, portal.
- `routes/stripeWebhook.ts` — the only path that may change entitlements.

Two deliberate asymmetries:

1. **Stripe decides, the app enforces.** Tier comes from the `subscriptions`
   row, written only by signature-verified webhooks. A client can start a
   checkout; it can never assert its own tier.

2. **Unconfigured billing fails open; delinquent billing fails closed.** A
   deployment with no `STRIPE_SECRET_KEY` grants the top tier, so demo and
   design-partner installs are not crippled by the absence of a payment
   processor they were never given. An org that *has* a subscription and
   stopped paying drops to Starter. These are opposite defaults on purpose:
   the first is about not breaking installs, the second about not giving away
   the product.

Card data never reaches this application. Checkout and payment-method
management both live on Stripe-hosted pages.

## Alternatives considered

- **Stripe Billing with metered usage.** Rejected for v1: per-seat metering
  adds proration and usage-reporting complexity before a single customer has
  validated the pricing shape.
- **Paddle / Lemon Squeezy (merchant of record).** Simpler tax handling, but
  worse subscription primitives and a weaker portal, and it puts a third party
  between the agency and its invoices in a market where FMOs expect direct
  billing records.
- **Enforcement in each route handler.** Rejected — enforcement that is
  reimplemented per route is enforcement that gets forgotten in the 49th route.

## Tradeoffs

- The projection can lag Stripe if a webhook is lost. Mitigated by Stripe's own
  retry policy and by the idempotency ledger releasing its claim on failure so
  a retry can reprocess.
- `organizations.plan_tier` is now denormalized against `subscriptions`. Kept
  because existing code reads it; written on every subscription change and
  constrained by a CHECK so it cannot drift out of vocabulary.
- Seat enforcement counts agent records, not Clerk seats. Adequate while an
  agent record is the unit an agency actually buys.

## Reversibility

Costly but not one-way. The tables are additive, the middleware is two lines
per route, and removing Stripe means deleting the routes and letting
`isBillingConfigured()` return false — which restores exactly the previous
unlimited behavior.

## Follow-up

- Annual pricing and promotion codes (`allow_promotion_codes` is already on).
- Dunning emails on `invoice.payment_failed` via the existing Resend templates.
- Feature gates (`enforceFeature`) are implemented but not yet applied to the
  commission, e-sign, AI, and voice routes — capacity limits are enforced,
  feature limits are advertised. This is the next billing change to make.
