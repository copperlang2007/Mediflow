/**
 * Stripe client construction.
 *
 * Billing is optional infrastructure: a deployment without `STRIPE_SECRET_KEY`
 * boots normally and simply reports every org as unbilled on the free tier.
 * That is deliberate — a demo, a design-partner install, or a local dev boot
 * must not require a payment processor. Routes that genuinely need Stripe
 * return 503 with an operator-actionable message instead of throwing on import.
 */
import Stripe from "stripe";

import { logger } from "../logger";

let cached: Stripe | null = null;
let warned = false;

/** True when the deployment is configured to take payments. */
export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/**
 * Returns the shared Stripe client, or `null` when billing is unconfigured.
 * Callers must handle `null` — see `requireStripe` for the route-level path.
 */
export function getStripe(): Stripe | null {
  if (cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    if (!warned) {
      warned = true;
      logger.warn(
        "STRIPE_SECRET_KEY is not set — billing routes are disabled and every org resolves to the free starter tier.",
      );
    }
    return null;
  }

  cached = new Stripe(key, {
    // Pin the API version so a Stripe-side upgrade can never silently change
    // webhook payload shapes under a running deployment.
    apiVersion: "2026-08-26.dahlia",
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "MediFlow", url: "https://mediflow.app" },
  });

  return cached;
}

/** Webhook signing secret for `POST /webhooks/stripe`. */
export function webhookSecret(): string | undefined {
  const raw = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return raw ? raw : undefined;
}

/** Test seam — resets the memoized client between test cases. */
export function resetStripeClientForTests(): void {
  cached = null;
  warned = false;
}
