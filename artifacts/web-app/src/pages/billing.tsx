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
  Clock,
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
import { PageHeader, KpiCard, SectionCard, StatusPill, TechnicalDetails, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid, NoticeBanner } from "@/components/ops";
import { Users, Contact, CalendarClock, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

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
  voiceStack: "Voice AI calling",
  eSignature: "E-signature",
  apiAccess: "API access",
  ssoEnforcement: "Single sign-on (SSO) enforcement",
};

/**
 * Plan features whose engine isn't built yet. The plan catalog reserves them
 * for a tier, but nothing in the app provides them today (no browser calling,
 * no customer API keys, no SSO enforcement), so they are shown as
 * "Coming soon" and never as included.
 */
const COMING_SOON_FEATURES = new Set(["voiceStack", "apiAccess", "ssoEnforcement"]);

const TIER_ORDER: PlanTier[] = ["starter", "growth", "agency"];

function money(cents: number): string {
  return cents === 0
    ? "Free"
    : `$${(cents / 100).toLocaleString("en-US", {
        maximumFractionDigits: 0,
      })}`;
}

/** Maps a subscription status to the badge the header should show. */
function statusBadge(sub: Subscription): { label: string; tone: StatusTone } {
  if (!sub.billingConfigured) {
    return { label: "Unbilled deployment", tone: "neutral" };
  }
  switch (sub.status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "trialing":
      return { label: "Trial", tone: "info" };
    case "past_due":
      return { label: "Past due", tone: "danger" };
    case "canceled":
      return { label: "Canceled", tone: "danger" };
    case "unpaid":
      return { label: "Unpaid", tone: "danger" };
    default:
      return { label: "No subscription", tone: "neutral" };
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
      {!unlimited ? <Progress value={pct} className="h-2" /> : <div className="h-2 rounded-full bg-success/20" />}
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
    meta: { toastOnError: true },
  });

  const portal = useMutation({
    mutationFn: () =>
      apiRequest<{ url: string }>("/api/billing/portal", { method: "POST" }),
    onSuccess: ({ url }) => {
      if (url) window.location.href = url;
    },
    meta: { toastOnError: true },
  });

  if (subLoading || plansLoading) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 rounded-xl" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-80 rounded-xl" />
          ))}
        </div>
      </PageShell>
    );
  }

  if (!sub || !catalog) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Billing unavailable</AlertTitle>
          <AlertDescription>
            Could not load subscription details. Refresh, or contact support if
            this persists.
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  const badge = statusBadge(sub);
  const currentIndex = TIER_ORDER.indexOf(sub.tier);

  return (
    <PageShell>
      <PageHeader
        title="Billing & plan"
        subtitle="Your plan, what you're using, and how you pay. Card details are handled by Stripe and never stored here."
      >
        <StatusPill tone={badge.tone} className="text-sm px-3 py-1">{badge.label}</StatusPill>
      </PageHeader>

      {!sub.billingConfigured && (
        <NoticeBanner icon={Info} title="Online payments aren't switched on yet">
          Payments haven't been connected for this account, so every available
          feature is unlocked and no plan limits apply. Whoever runs your
          installation can connect Stripe to turn on billing.
          <TechnicalDetails>
            Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* variables on the server to turn on billing.
          </TechnicalDetails>
        </NoticeBanner>
      )}

      <KpiGrid>
        <KpiCard label="Current plan" value={sub.plan.name} icon={Sparkles} color="navy" hint={money(sub.plan.monthlyPriceCents) + (sub.plan.monthlyPriceCents > 0 ? " per month" : "")} />
        <KpiCard
          label="Agents"
          value={sub.usage.agents.toLocaleString()}
          icon={Users}
          color="blue"
          hint={sub.plan.limits.agents === null ? "No limit on your plan" : `of ${sub.plan.limits.agents.toLocaleString()} on your plan`}
        />
        <KpiCard
          label="Contacts"
          value={sub.usage.contacts.toLocaleString()}
          icon={Contact}
          color="green"
          hint={sub.plan.limits.contacts === null ? "No limit on your plan" : `of ${sub.plan.limits.contacts.toLocaleString()} on your plan`}
        />
        <KpiCard
          label={sub.cancelAtPeriodEnd ? "Access ends" : "Renews"}
          value={<span className="text-2xl">{sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : "—"}</span>}
          icon={CalendarClock}
          color="orange"
          hint={sub.currentPeriodEnd ? (sub.hasPaymentMethod ? "Card on file" : "No card on file") : "No billing period"}
        />
      </KpiGrid>

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

      <SectionCard
        title={`${sub.plan.name} plan`}
        description={sub.plan.blurb}
        icon={CreditCard}
        contentClassName="space-y-5"
        actions={sub.hasPaymentMethod ? (
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
          ) : undefined}
      >

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
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-3">
        {catalog.plans.map((plan) => {
          const isCurrent = plan.tier === sub.tier;
          const isDowngrade = TIER_ORDER.indexOf(plan.tier) < currentIndex;

          return (
            <Card
              key={plan.tier}
              className={cn("relative rounded-xl shadow-sm", isCurrent && "border-2 border-navy-800 dark:border-primary shadow-md")}
            >
              {isCurrent && (
                <span className="absolute -top-2.5 left-4 rounded-full bg-navy-800 px-2.5 py-0.5 text-[11px] font-semibold text-white dark:bg-primary dark:text-primary-foreground">
                  Your plan
                </span>
              )}
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between font-display">
                  <span>{plan.name}</span>
                  <span className="text-2xl font-bold">
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
                    <Check className="h-4 w-4 shrink-0 text-success" />
                    {plan.limits.agents === null
                      ? "Unlimited agents"
                      : `Up to ${plan.limits.agents} agents`}
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-success" />
                    {plan.limits.contacts === null
                      ? "Unlimited contacts"
                      : `${plan.limits.contacts.toLocaleString()} contacts`}
                  </li>
                  {Object.entries(plan.limits.features)
                    .filter(([key, on]) => on && !COMING_SOON_FEATURES.has(key))
                    .map(([key]) => (
                      <li key={key} className="flex items-center gap-2">
                        <Check className="h-4 w-4 shrink-0 text-success" />
                        {FEATURE_LABELS[key] ?? key}
                      </li>
                    ))}
                  {Object.entries(plan.limits.features)
                    .filter(([key, on]) => on && COMING_SOON_FEATURES.has(key))
                    .map(([key]) => (
                      <li key={key} className="flex items-center gap-2 text-muted-foreground" data-testid={`coming-soon-${key}`}>
                        <Clock className="h-4 w-4 shrink-0" />
                        <span className="min-w-0">{FEATURE_LABELS[key] ?? key}</span>
                        <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                          Coming soon
                        </span>
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
    </PageShell>
  );
}
