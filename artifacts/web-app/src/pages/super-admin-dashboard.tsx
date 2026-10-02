/**
 * Platform dashboard — what a super admin sees instead of an agency's own
 * dashboard. Every number comes from GET /api/admin/agencies/overview (live
 * counts per agency, super_admin + MFA only); nothing here is invented.
 *
 * The agency dashboard still exists: pick "View" on any agency and the app
 * opens that agency read-only, exactly as the "View an agency" menu does.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Building2,
  Eye,
  Loader2,
  MailPlus,
  RefreshCw,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
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

const OVERVIEW_KEY = ["/api/admin/agencies/overview"] as const;
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
  const agencies = overview.data?.agencies;
  const ready = overview.isSuccess;
  const dash = (n: number) => (ready ? n : "–");

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
      // Invited but nobody has signed in yet — the ones worth a nudge.
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
        <Button variant="outline" onClick={() => void overview.refetch()} disabled={overview.isFetching}>
          {overview.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
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

      <div className="grid items-start gap-6 lg:grid-cols-[1.6fr_1fr] [&>*]:min-w-0">
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
                    <th className="px-3 py-2">Agency</th>
                    <th className="px-3 py-2">Plan</th>
                    <th className="px-3 py-2 text-right">Accounts</th>
                    <th className="px-3 py-2 text-right">Agents</th>
                    <th className="px-3 py-2 text-right">Clients</th>
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
                      <td className="px-3 py-2.5 text-muted-foreground">{titleCase(a.planTier)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.users}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.agents}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.clients}</td>
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

        <div className="space-y-6">
          {totals.stalled.length > 0 && (
            <SectionCard title="Needs a nudge" description="Invited, but nobody has signed in yet.">
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
