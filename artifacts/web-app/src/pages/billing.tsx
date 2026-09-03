/**
 * Billing & plan management.
 *
 * Reads `/billing/subscription` for the org's current entitlements and live
 * usage, and `/billing/plans` for the catalog. Upgrading hands off to Stripe
 * Checkout; managing an existing subscription hands off to the Stripe billing
 * portal. No card data ever touches this application.
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  CreditCard,
  Check,
  ExternalLink,
  AlertTriangle,
  Info,
  Loader2,
} from "lucide-react";

import { apiRequest } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";

type PlanTier = "starter" | "growth" | "agency";

interface PlanLimits {
  agents: number | null;
  contacts: number | null;
  features: Record<string, boolean>;
}

interface Plan {
  tier: PlanTier;
  name: string;
  monthlyPriceCents: number;
  blurb: string;
  includedSeats: number;
  limits: PlanLimits;
  purchasable: boolean;
}

interface Subscription {
  tier: PlanTier;
  plan: Plan;
  status: string;
  seats: number;
  billingConfigured: boolean;
  unbilledGrant: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
  usage: { agents: number; contacts: number };
}

const FEATURE_LABELS: Record<string, string> = {
  commissionReconciliation: "Commission reconciliation",
  aiAssistant: "AI assistant",
  voiceStack: "Voice AI stack",
  eSignature: "E-signature",
  apiAccess: "API access",
  ssoEnforcement: "SSO enforcement",
};

const TIER_ORDER: PlanTier[] = ["starter", "growth", "agency"];

function money(cents: number): string {
  return cents === 0
    ? "Free"
    : `$${(cents / 100).toLocaleString("en-US", {
        maximumFractionDigits: 0,
      })}`;
}

/** Maps a subscription status to the badge the header should show. */
function statusBadge(sub: Subscription) {
  if (!sub.billingConfigured) {
    return { label: "Unbilled deployment", variant: "secondary" as const };
  }
  switch (sub.status) {
    case "active":
      return { label: "Active", variant: "default" as const };
    case "trialing":
      return { label: "Trial", variant: "default" as const };
    case "past_due":
      return { label: "Past due", variant: "destructive" as const };
    case "canceled":
      return { label: "Canceled", variant: "destructive" as const };
    case "unpaid":
      return { label: "Unpaid", variant: "destructive" as const };
    default:
      return { label: "No subscription", variant: "secondary" as const };
  }
}

function UsageMeter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const unlimited = limit === null;
  const pct = unlimited ? 0 : Math.min(100, (used / Math.max(limit, 1)) * 100);
  const atLimit = !unlimited && used >= limit;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={atLimit ? "font-medium text-destructive" : "font-medium"}>
          {used.toLocaleString()}
          {unlimited ? " / unlimited" : ` / ${limit.toLocaleString()}`}
        </span>
      </div>
      {!unlimited && <Progress value={pct} className="h-2" />}
    </div>
  );
}

export default function BillingPage() {
  const [pendingTier, setPendingTier] = useState<PlanTier | null>(null);

  const { data: sub, isLoading: subLoading } = useQuery({
    queryKey: ["billing", "subscription"],
    queryFn: () => apiRequest<Subscription>("/api/billing/subscription"),
  });

  const { data: catalog, isLoading: plansLoading } = useQuery({
    queryKey: ["billing", "plans"],
    queryFn: () =>
      apiRequest<{ billingConfigured: boolean; plans: Plan[] }>(
        "/api/billing/plans",
      ),
  });

  const checkout = useMutation({
    mutationFn: (tier: PlanTier) =>
      apiRequest<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ tier }),
      }),
    onSuccess: ({ url }) => {
      // Full navigation, not a new tab: Stripe Checkout is a redirect flow and
      // returns the buyer to our success_url when it completes.
      if (url) window.location.href = url;
      else toast.error("Stripe did not return a checkout URL.");
    },
    onSettled: () => setPendingTier(null),
  });

  const portal = useMutation({
    mutationFn: () =>
      apiRequest<{ url: string }>("/api/billing/portal", { method: "POST" }),
    onSuccess: ({ url }) => {
      if (url) window.location.href = url;
    },
  });

  if (subLoading || plansLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 rounded-xl" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-80 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!sub || !catalog) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Billing unavailable</AlertTitle>
          <AlertDescription>
            Could not load subscription details. Refresh, or contact support if
            this persists.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const badge = statusBadge(sub);
  const currentIndex = TIER_ORDER.indexOf(sub.tier);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <CreditCard className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Billing &amp; plan
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage your subscription, seats, and payment method.
          </p>
        </div>
      </div>

      {!sub.billingConfigured && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>This deployment does not take payments</AlertTitle>
          <AlertDescription>
            No Stripe keys are configured, so every feature is unlocked and no
            limits are enforced. Set <code>STRIPE_SECRET_KEY</code> and the{" "}
            <code>STRIPE_PRICE_*</code> variables to turn on billing.
          </AlertDescription>
        </Alert>
      )}

      {sub.status === "past_due" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Payment failed</AlertTitle>
          <AlertDescription>
            We could not charge your card. Update your payment method to keep
            your plan — access drops to Starter limits if the retries fail.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2">
            {sub.plan.name} plan
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </CardTitle>
          {sub.hasPaymentMethod && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => portal.mutate()}
              disabled={portal.isPending}
            >
              {portal.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="mr-2 h-4 w-4" />
              )}
              Manage in Stripe
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">{sub.plan.blurb}</p>

          {sub.currentPeriodEnd && (
            <p className="text-sm">
              {sub.cancelAtPeriodEnd ? "Access ends" : "Renews"} on{" "}
              <span className="font-medium">
                {new Date(sub.currentPeriodEnd).toLocaleDateString()}
              </span>
            </p>
          )}

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <UsageMeter
              label="Agents"
              used={sub.usage.agents}
              limit={sub.plan.limits.agents}
            />
            <UsageMeter
              label="Contacts"
              used={sub.usage.contacts}
              limit={sub.plan.limits.contacts}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {catalog.plans.map((plan) => {
          const isCurrent = plan.tier === sub.tier;
          const isDowngrade = TIER_ORDER.indexOf(plan.tier) < currentIndex;

          return (
            <Card
              key={plan.tier}
              className={isCurrent ? "border-primary shadow-sm" : undefined}
            >
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between">
                  <span>{plan.name}</span>
                  <span className="text-2xl font-semibold">
                    {money(plan.monthlyPriceCents)}
                    {plan.monthlyPriceCents > 0 && (
                      <span className="text-sm font-normal text-muted-foreground">
                        /mo
                      </span>
                    )}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground min-h-[3rem]">
                  {plan.blurb}
                </p>

                <ul className="space-y-2 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                    {plan.limits.agents === null
                      ? "Unlimited agents"
                      : `Up to ${plan.limits.agents} agents`}
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                    {plan.limits.contacts === null
                      ? "Unlimited contacts"
                      : `${plan.limits.contacts.toLocaleString()} contacts`}
                  </li>
                  {Object.entries(plan.limits.features)
                    .filter(([, on]) => on)
                    .map(([key]) => (
                      <li key={key} className="flex items-center gap-2">
                        <Check className="h-4 w-4 shrink-0 text-primary" />
                        {FEATURE_LABELS[key] ?? key}
                      </li>
                    ))}
                </ul>

                {isCurrent ? (
                  <Button className="w-full" variant="secondary" disabled>
                    Current plan
                  </Button>
                ) : isDowngrade ? (
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() => portal.mutate()}
                    disabled={!sub.hasPaymentMethod || portal.isPending}
                  >
                    Downgrade in Stripe
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => {
                      setPendingTier(plan.tier);
                      checkout.mutate(plan.tier);
                    }}
                    disabled={!plan.purchasable || checkout.isPending}
                  >
                    {pendingTier === plan.tier && checkout.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {plan.purchasable
                      ? `Upgrade to ${plan.name}`
                      : "Not available"}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
