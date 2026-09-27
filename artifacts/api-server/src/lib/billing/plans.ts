/**
 * Plan catalog — the single source of truth for what each tier includes.
 *
 * Prices are declared here for display only; Stripe holds the authoritative
 * amount attached to each price id, and checkout always uses the Stripe price.
 * Keeping the display copy next to the limits means the pricing page and the
 * enforcement code can never disagree about what a tier is.
 *
 * Limits are enforced server-side in `entitlements.ts`. A limit of `null`
 * means unlimited.
 */

export const PLAN_TIERS = ["starter", "growth", "agency"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface PlanLimits {
  /** Licensed agent records the org may hold. */
  agents: number | null;
  /** Beneficiary/contact records the org may hold. */
  contacts: number | null;
  /** Feature flags gated by tier. */
  features: {
    commissionReconciliation: boolean;
    aiAssistant: boolean;
    voiceStack: boolean;
    eSignature: boolean;
    apiAccess: boolean;
    ssoEnforcement: boolean;
  };
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  /** Display price in USD cents, per month. Stripe remains authoritative. */
  monthlyPriceCents: number;
  blurb: string;
  limits: PlanLimits;
  /** Seats bundled before per-seat overage applies. */
  includedSeats: number;
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  starter: {
    tier: "starter",
    name: "Starter",
    monthlyPriceCents: 0,
    blurb:
      "For a solo agent getting organized. Full CRM, licensing, and AHIP tracking.",
    includedSeats: 3,
    limits: {
      agents: 3,
      contacts: 250,
      features: {
        commissionReconciliation: false,
        aiAssistant: false,
        voiceStack: false,
        eSignature: false,
        apiAccess: false,
        ssoEnforcement: false,
      },
    },
  },
  growth: {
    tier: "growth",
    name: "Growth",
    monthlyPriceCents: 29_700,
    blurb:
      "For a working agency. Adds commission reconciliation, e-signature, and the AI assistant.",
    includedSeats: 15,
    limits: {
      agents: 15,
      contacts: 5_000,
      features: {
        commissionReconciliation: true,
        aiAssistant: true,
        voiceStack: false,
        eSignature: true,
        apiAccess: false,
        ssoEnforcement: false,
      },
    },
  },
  agency: {
    tier: "agency",
    name: "Agency",
    monthlyPriceCents: 99_700,
    blurb:
      "For a multi-downline FMO. Everything in Growth with unlimited agents and contacts.",
    includedSeats: 100,
    limits: {
      agents: null,
      contacts: null,
      features: {
        commissionReconciliation: true,
        aiAssistant: true,
        voiceStack: true,
        eSignature: true,
        apiAccess: true,
        ssoEnforcement: true,
      },
    },
  },
};

export type PlanFeature = keyof PlanLimits["features"];

export function isPlanTier(value: string): value is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(value);
}

/**
 * Resolves the Stripe price id configured for a tier.
 *
 * Price ids are environment-specific (test vs live mode), so they live in env
 * rather than in this file. `starter` is free and has no price id.
 */
export function stripePriceIdFor(tier: PlanTier): string | undefined {
  if (tier === "starter") return undefined;
  const raw = process.env[`STRIPE_PRICE_${tier.toUpperCase()}`];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reverse lookup used by the webhook to map a Stripe price back to a tier. */
export function tierForStripePrice(priceId: string): PlanTier | undefined {
  return PLAN_TIERS.find((tier) => stripePriceIdFor(tier) === priceId);
}
