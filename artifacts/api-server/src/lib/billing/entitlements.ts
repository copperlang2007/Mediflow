/**
 * Entitlements — what an org is actually allowed to do, right now.
 *
 * `organizations.plan_tier` existed long before this module and nothing read
 * it, which meant every deployment was effectively unlimited. This is the
 * enforcement layer that closes that gap.
 *
 * Two rules govern the design:
 *
 *  1. **Stripe decides, the app enforces.** The tier comes from the
 *     `subscriptions` row, which is written only by verified webhooks. A
 *     client can ask to start a checkout; it can never assert its own tier.
 *
 *  2. **Unconfigured billing fails OPEN, delinquent billing fails CLOSED.**
 *     A deployment with no `STRIPE_SECRET_KEY` (demo, design partner, local
 *     dev) grants the full plan so nobody is locked out of a product they
 *     were handed. But an org that *has* a subscription and stopped paying
 *     drops to starter limits. Those are opposite defaults on purpose: the
 *     first is about not breaking installs, the second is about not giving
 *     away the product.
 */
import { eq, count } from "drizzle-orm";
import {
  db,
  subscriptionsTable,
  organizationsTable,
  agentsTable,
  contactsTable,
} from "@workspace/db";

import {
  PLANS,
  isPlanTier,
  type PlanDefinition,
  type PlanFeature,
  type PlanTier,
} from "./plans";
import { isBillingConfigured } from "./stripe";
import { logger } from "../logger";

/** Subscription statuses that entitle an org to its paid tier. */
const ENTITLING_STATUSES = new Set(["trialing", "active"]);

/**
 * Statuses meaning "paid once, currently failing to pay". These keep the tier
 * for a grace window handled by Stripe's own dunning, then lose it — we treat
 * `past_due` as still entitled (Stripe is retrying the card) and `unpaid` /
 * `canceled` as not.
 */
const GRACE_STATUSES = new Set(["past_due"]);

export interface Entitlements {
  orgId: string;
  tier: PlanTier;
  plan: PlanDefinition;
  seats: number;
  status: string;
  /** True when this deployment takes payments at all. */
  billingConfigured: boolean;
  /** True when the tier is granted because billing is unconfigured. */
  unbilledGrant: boolean;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: Entitlements; fetchedAt: number }>();

/** Drops an org's cached entitlements — call after any subscription write. */
export function invalidateEntitlements(orgId: string): void {
  cache.delete(orgId);
}

export function resetEntitlementsCacheForTests(): void {
  cache.clear();
}

/**
 * Resolves the effective entitlements for an org.
 *
 * Cached for 30s. A webhook that changes a subscription invalidates the entry
 * immediately, so the TTL only bounds staleness for changes made out of band
 * (a plan edited directly in the Stripe dashboard).
 */
export async function getEntitlements(orgId: string): Promise<Entitlements> {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.orgId, orgId))
    .limit(1);

  const value = deriveEntitlements(orgId, row ?? null);
  cache.set(orgId, { value, fetchedAt: Date.now() });
  return value;
}

/**
 * The pure mapping from a subscription row to what it entitles.
 *
 * Split out from `getEntitlements` so a caller holding a transaction can read
 * the subscription on *its own* connection and derive the same answer, without
 * going through the module-level `db` handle or the cache. Seat enforcement
 * needs exactly that: an entitlement read outside the seat lock can be stale by
 * the time the lock is held, and a cached one can be staler still.
 *
 * Both paths share this function so the two can never disagree about what a
 * row means.
 */
export function deriveEntitlements(
  orgId: string,
  row: typeof subscriptionsTable.$inferSelect | null,
): Entitlements {
  const billingConfigured = isBillingConfigured();

  // No payment processor wired up: this is a demo or design-partner install.
  // Grant the top tier rather than crippling a product someone was handed.
  if (!billingConfigured) {
    return {
      orgId,
      tier: "agency",
      plan: PLANS.agency,
      seats: PLANS.agency.includedSeats,
      status: row?.status ?? "none",
      billingConfigured: false,
      unbilledGrant: true,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }

  const status = row?.status ?? "none";
  const entitled =
    row != null &&
    (ENTITLING_STATUSES.has(status) || GRACE_STATUSES.has(status));

  const tier: PlanTier =
    entitled && isPlanTier(row.planTier) ? row.planTier : "starter";

  return {
    orgId,
    tier,
    plan: PLANS[tier],
    seats: row?.seats ?? PLANS[tier].includedSeats,
    status,
    billingConfigured: true,
    unbilledGrant: false,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
  };
}

/** Error thrown when an action exceeds the org's plan. */
export class PlanLimitError extends Error {
  readonly statusCode = 402;
  constructor(
    message: string,
    readonly detail: {
      tier: PlanTier;
      limit?: number | null;
      current?: number;
      feature?: PlanFeature;
      upgradeTo?: PlanTier;
    },
  ) {
    super(message);
    this.name = "PlanLimitError";
  }
}

/** The cheapest tier that includes `feature`, for upgrade prompts. */
function cheapestTierWith(feature: PlanFeature): PlanTier | undefined {
  return (Object.keys(PLANS) as PlanTier[])
    .sort((a, b) => PLANS[a].monthlyPriceCents - PLANS[b].monthlyPriceCents)
    .find((t) => PLANS[t].limits.features[feature]);
}

/**
 * Asserts the org's plan includes a gated feature.
 * Throws `PlanLimitError` (HTTP 402) when it does not.
 */
export async function requireFeature(
  orgId: string,
  feature: PlanFeature,
): Promise<void> {
  const ent = await getEntitlements(orgId);
  if (ent.plan.limits.features[feature]) return;

  throw new PlanLimitError(
    `Your ${ent.plan.name} plan does not include this feature.`,
    { tier: ent.tier, feature, upgradeTo: cheapestTierWith(feature) },
  );
}

/**
 * Asserts the org is below its record limit for `resource` before creating
 * one more. Counts live rather than caching — a count that lags is a count
 * that lets an org past its plan, and these are cheap indexed aggregates.
 */
export async function requireCapacity(
  orgId: string,
  resource: "agents" | "contacts",
): Promise<void> {
  const ent = await getEntitlements(orgId);
  const limit = ent.plan.limits[resource];
  if (limit == null) return; // unlimited

  const table = resource === "agents" ? agentsTable : contactsTable;
  const [row] = await db
    .select({ n: count() })
    .from(table)
    .where(eq(table.orgId, orgId));

  const current = row?.n ?? 0;
  if (current < limit) return;

  const upgradeTo = (Object.keys(PLANS) as PlanTier[])
    .sort((a, b) => PLANS[a].monthlyPriceCents - PLANS[b].monthlyPriceCents)
    .find((t) => {
      const l = PLANS[t].limits[resource];
      return l == null || l > limit;
    });

  throw new PlanLimitError(
    `Your ${ent.plan.name} plan is limited to ${limit} ${resource}.`,
    { tier: ent.tier, limit, current, upgradeTo },
  );
}

/**
 * Keeps `organizations.plan_tier` in step with the subscription row.
 *
 * The column is denormalized (it predates `subscriptions` and is read in
 * existing code paths), so it is written here rather than left to drift.
 */
export async function syncOrgPlanTier(
  orgId: string,
  tier: PlanTier,
): Promise<void> {
  await db
    .update(organizationsTable)
    .set({ planTier: tier })
    .where(eq(organizationsTable.id, orgId));
  invalidateEntitlements(orgId);
  logger.info({ orgId, tier }, "Org plan tier synced");
}

/** Express-friendly serialization of a `PlanLimitError`. */
export function planLimitResponse(err: PlanLimitError) {
  return {
    error: err.message,
    code: "plan_limit_exceeded",
    ...err.detail,
  };
}
