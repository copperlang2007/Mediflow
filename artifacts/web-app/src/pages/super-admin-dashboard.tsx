/**
 * Platform dashboard — what a super admin sees instead of an agency's own
 * dashboard. Every number comes from GET /api/admin/agencies/overview (live
 * counts per agency) and GET /api/admin/platform/metrics (revenue,
 * commissions, 12-month growth); both are super_admin + MFA only and nothing
 * here is invented. If either request fails its figures show "–", never zero.
 *
 * The agency dashboard still exists: pick "View" on any agency and the app
 * opens that agency read-only, exactly as the "View an agency" menu does.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Boxes,
  Building2,
  CircleDollarSign,
  Eye,
  Loader2,
  MailPlus,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useGetMe } from "@workspace/api-client-react";
import { KpiCard, PageHeader, SectionCard, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface AgencyRow {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  createdAt: string;
  users: number;
  agents: number;
  clients: number;
  pendingInvitations: number;
}

interface GrowthMonth {
  month: string;
  newAgencies: number;
  totalAgencies: number;
  newClients: number;
  totalClients: number;
  commissionsCents: number;
}

interface AgencyMetrics {
  orgId: string;
  subscriptionStatus: string;
  planTier: string | null;
  mrrCents: number;
  commissionsLast12MonthsCents: number;
  commissionsAllTimeCents: number;
}

interface PlatformMetrics {
  months: string[];
  revenue: {
    basis: "list_price";
    mrrCents: number;
    arrCents: number;
    payingAgencies: number;
    trialingAgencies: number;
    pastDueAgencies: number;
    atRiskCents: number;
    byPlan: { tier: string; agencies: number; mrrCents: number }[];
  };
  commissions: { allTimeCents: number; last12MonthsCents: number };
  growth: GrowthMonth[];
  agencies: AgencyMetrics[];
}

const OVERVIEW_KEY = ["/api/admin/agencies/overview"] as const;
const METRICS_KEY = ["/api/admin/platform/metrics"] as const;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdExact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const money = (cents: number) => usd.format(cents / 100);

/** "2026-03" → "Mar 26" (UTC-safe: built from the parts, not a Date). */
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  fontSize: 13,
};
const AXIS_TICK = { fontSize: 12, fill: "hsl(var(--muted-foreground))" };
const VIEW_AS_KEY = "mediflow:view-as-org";
const SUPPORT_REASON_KEY = "mediflow:support-edit-reason";

/** Returns false (and does not navigate) when browser storage is unavailable. */
function viewAgency(id: string): boolean {
  try {
    // A support-edit reason from an earlier agency must not carry over.
    sessionStorage.removeItem(SUPPORT_REASON_KEY);
    localStorage.setItem(VIEW_AS_KEY, id);
  } catch {
    return false;
  }
  window.location.assign(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/dashboard`);
  return true;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function SuperAdminDashboard() {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const openAgency = (id: string) => {
    if (!viewAgency(id)) {
      toast({
        title: "Could not open this agency",
        description: "Site storage is disabled or full. Turn off private browsing or clear site data, then try again.",
        variant: "destructive",
      });
    }
  };
  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => apiFetch<{ agencies: AgencyRow[] }>("/api/admin/agencies/overview"),
  });
  const metrics = useQuery({
    queryKey: METRICS_KEY,
    queryFn: () => apiFetch<PlatformMetrics>("/api/admin/platform/metrics"),
  });
  const agencies = overview.data?.agencies;
  const ready = overview.isSuccess;
  const dash = (n: number) => (ready ? n : "–");
  const m = metrics.data;
  const moneyOrDash = (cents: number | undefined) => (m && cents !== undefined ? money(cents) : "–");
  const [growthView, setGrowthView] = useState<"agencies" | "clients">("agencies");
  const metricsByOrg = useMemo(() => new Map((m?.agencies ?? []).map((a) => [a.orgId, a])), [m]);

  const totals = useMemo(() => {
    const rows = agencies ?? [];
    const plans = new Map<string, number>();
    for (const r of rows) plans.set(r.planTier, (plans.get(r.planTier) ?? 0) + 1);
    return {
      agencies: rows.length,
      users: rows.reduce((s, r) => s + r.users, 0),
      agents: rows.reduce((s, r) => s + r.agents, 0),
      clients: rows.reduce((s, r) => s + r.clients, 0),
      plans: [...plans.entries()].sort((a, b) => b[1] - a[1]),
      // Invited, with no active accounts yet — the ones worth a nudge.
      stalled: rows.filter((r) => r.pendingInvitations > 0 && r.users === 0),
    };
  }, [agencies]);

  const mfaNeeded =
    overview.isError &&
    (overview.error as Error & { data?: { error?: string } }).data?.error === "mfa_required";

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        eyebrow="Super Admin"
        title="Platform overview"
        subtitle="Every agency on the platform at a glance. Open any agency to see exactly what they see."
      >
        <Button
          variant="outline"
          onClick={() => void Promise.all([overview.refetch(), metrics.refetch()])}
          disabled={overview.isFetching || metrics.isFetching}
        >
          {overview.isFetching || metrics.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
        <Button asChild>
          <Link href="/admin/workspaces"><MailPlus className="mr-2 h-4 w-4" /> New agency</Link>
        </Button>
      </PageHeader>

      {overview.isError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {mfaNeeded ? (
            <>
              Turn on two-step verification to see platform data.{" "}
              <Link href="/settings/security" className="underline underline-offset-2">Set it up</Link>
            </>
          ) : (
            "Could not load the platform overview. Refresh to try again."
          )}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Agencies" value={dash(totals.agencies)} icon={Building2} color="navy" loading={overview.isLoading} href="/admin/workspaces" />
        <KpiCard label="Active accounts" value={dash(totals.users)} icon={Users} color="blue" loading={overview.isLoading} />
        <KpiCard label="Agents" value={dash(totals.agents)} icon={UserCog} color="green" loading={overview.isLoading} />
        <KpiCard label="Clients managed" value={dash(totals.clients)} icon={ShieldCheck} color="orange" loading={overview.isLoading} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          variant="white"
          color="green"
          icon={CircleDollarSign}
          label="Monthly revenue (est.)"
          value={moneyOrDash(m?.revenue.mrrCents)}
          hint={m ? `${m.revenue.payingAgencies} paying · ${m.revenue.trialingAgencies} on trial` : undefined}
          loading={metrics.isLoading}
        />
        <KpiCard
          variant="white"
          color="green"
          icon={TrendingUp}
          label="Yearly run rate (est.)"
          value={moneyOrDash(m?.revenue.arrCents)}
          hint="Monthly revenue × 12"
          loading={metrics.isLoading}
        />
        <KpiCard
          variant="white"
          color="orange"
          icon={AlertTriangle}
          label="Revenue at risk"
          value={moneyOrDash(m?.revenue.atRiskCents)}
          hint={m ? `${m.revenue.pastDueAgencies} agenc${m.revenue.pastDueAgencies === 1 ? "y" : "ies"} past due` : undefined}
          loading={metrics.isLoading}
        />
        <KpiCard
          variant="white"
          color="blue"
          icon={Wallet}
          label="Agency commissions, 12 mo"
          value={moneyOrDash(m?.commissions.last12MonthsCents)}
          hint="Earned by agencies from carriers"
          loading={metrics.isLoading}
        />
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        {metrics.isError
          ? "Revenue and commission figures are unavailable right now."
          : "Revenue is estimated from active plans at list price (no seat overage, discounts or proration); Stripe is the source of truth. Commissions are what agencies earned from carriers, not platform revenue."}
      </p>

      <div className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <SectionCard title="Agency commissions by month" description="Carrier commissions earned across all agencies.">
          {metrics.isLoading ? (
            <Skeleton className="h-56" />
          ) : !m ? (
            <p className="text-sm text-muted-foreground">Unavailable right now.</p>
          ) : (
            <div className="h-56" role="img" aria-label="Bar chart of agency commissions per month for the last 12 months; the same figures are in the table below.">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={m.growth} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="month" tickFormatter={monthLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} interval={1} />
                  <YAxis tickFormatter={(v: number) => usdCompact.format(v / 100)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(l: string) => monthLabel(l)}
                    formatter={(v: number) => [usdExact.format(v / 100), "Commissions"]}
                    cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
                  />
                  <Bar dataKey="commissionsCents" name="Commissions" fill="#3b6fa0" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title={growthView === "agencies" ? "Agencies over time" : "Clients over time"}
          description={growthView === "agencies" ? "Total agencies on the platform, month by month." : "Total clients managed across all agencies."}
        >
          <div className="mb-3 inline-flex rounded-md border border-border p-0.5 text-sm" role="group" aria-label="Choose what to chart">
            {(["agencies", "clients"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={growthView === v}
                onClick={() => setGrowthView(v)}
                className={`rounded px-3 py-1 ${growthView === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {v === "agencies" ? "Agencies" : "Clients"}
              </button>
            ))}
          </div>
          {metrics.isLoading ? (
            <Skeleton className="h-48" />
          ) : !m ? (
            <p className="text-sm text-muted-foreground">Unavailable right now.</p>
          ) : (
            <div className="h-48" role="img" aria-label={`Line chart of total ${growthView} per month for the last 12 months; the same figures are in the table below.`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={m.growth} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="month" tickFormatter={monthLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} interval={1} />
                  <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(l: string) => monthLabel(l)}
                    formatter={(v: number) => [v, growthView === "agencies" ? "Agencies" : "Clients"]}
                  />
                  <Line
                    type="monotone"
                    dataKey={growthView === "agencies" ? "totalAgencies" : "totalClients"}
                    stroke="#22a05a"
                    strokeWidth={2}
                    dot={{ r: 3, strokeWidth: 2 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>
      </div>

      {m && (
        <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">View the last 12 months as a table</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th className="px-3 py-2">Month</th>
                  <th className="px-3 py-2 text-right">New agencies</th>
                  <th className="px-3 py-2 text-right">Total agencies</th>
                  <th className="px-3 py-2 text-right">New clients</th>
                  <th className="px-3 py-2 text-right">Total clients</th>
                  <th className="px-3 py-2 text-right">Commissions</th>
                </tr>
              </thead>
              <tbody>
                {m.growth.map((g) => (
                  <tr key={g.month} className="border-b border-border/50">
                    <td className="px-3 py-2">{monthLabel(g.month)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.newAgencies}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.totalAgencies}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.newClients}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.totalClients}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usdExact.format(g.commissionsCents / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="space-y-6">
        <SectionCard title="Agencies" description="Live counts from each agency's records.">
          {overview.isLoading ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : !ready ? (
            <p className="text-sm text-muted-foreground">Agency data is unavailable right now.</p>
          ) : agencies!.length === 0 ? (
            <EmptyState icon={Building2} title="No agencies yet" description="Create the first one with “New agency”." compact />
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="min-w-[10rem] px-3 py-2">Agency</th>
                    <th className="px-3 py-2">Plan</th>
                    <th className="px-3 py-2 text-right">Accounts</th>
                    <th className="px-3 py-2 text-right">Agents</th>
                    <th className="px-3 py-2 text-right">Clients</th>
                    <th className="px-3 py-2 text-right">Revenue / mo</th>
                    <th className="px-3 py-2 text-right">Commissions (12 mo)</th>
                    <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {agencies!.map((a) => (
                    <tr key={a.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-3 py-2.5 font-medium">
                        <div className="flex flex-col">
                          <span>{a.name}</span>
                          {a.pendingInvitations > 0 && (
                            <span className="text-[11px] font-normal text-muted-foreground">
                              {a.pendingInvitations} pending invitation{a.pendingInvitations === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {(() => {
                          const x = metricsByOrg.get(a.id);
                          const tier = x?.planTier ?? a.planTier;
                          const status = x?.subscriptionStatus;
                          return (
                            <div className="flex flex-col">
                              <span>{titleCase(tier)}</span>
                              {status && status !== "active" && status !== "none" && (
                                <span className="text-[11px] capitalize">{status.replace(/_/g, " ")}</span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.users}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.agents}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.clients}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {m ? money(metricsByOrg.get(a.id)?.mrrCents ?? 0) : "–"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {m ? money(metricsByOrg.get(a.id)?.commissionsLast12MonthsCents ?? 0) : "–"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {me?.orgId && a.id !== me.orgId && (
                          <Button size="sm" variant="ghost" onClick={() => openAgency(a.id)} title="Open this agency read-only">
                            <Eye className="mr-1 h-3.5 w-3.5" /> View
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <div className="grid items-start gap-6 md:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
          {totals.stalled.length > 0 && (
            <SectionCard title="Needs a nudge" description="Invited, with no active accounts yet.">
              <ul className="space-y-2 text-sm">
                {totals.stalled.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    {me?.orgId && a.id !== me.orgId && (
                      <Button size="sm" variant="ghost" onClick={() => openAgency(a.id)}>View</Button>
                    )}
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <SectionCard title="Plans" description="How agencies are subscribed today.">
            {overview.isLoading ? (
              <Skeleton className="h-16" />
            ) : !ready ? (
              <p className="text-sm text-muted-foreground">Unavailable right now.</p>
            ) : totals.plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agencies yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {totals.plans.map(([tier, n]) => (
                  <li key={tier} className="flex items-center justify-between">
                    <span>{titleCase(tier)}</span>
                    <span className="tabular-nums text-muted-foreground">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Platform tools">
            <div className="grid gap-2">
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/workspaces"><Boxes className="mr-2 h-4 w-4" /> Manage agencies</Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/health"><Activity className="mr-2 h-4 w-4" /> System health</Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/settings/security"><ShieldCheck className="mr-2 h-4 w-4" /> Account security</Link>
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
