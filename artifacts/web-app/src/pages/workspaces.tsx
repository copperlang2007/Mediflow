/**
 * Workspaces (stage2/calendar-branding) — modelled on the agencyBRIDGE
 * TenantsPage. super_admin only (the API re-checks role + MFA on every call).
 *
 * Differences from the prototype, on purpose: sign-in is Clerk, so there is no
 * temporary password. Creating a workspace creates the agency and sends its
 * first administrator a normal invitation; the page shows the one-time link so
 * the operator can hand it over if email is not configured.
 */
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Check,
  Copy,
  Eye,
  Loader2,
  MailCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { KpiCard, PageHeader, SectionCard, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";

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

interface CreateResult {
  agency: { id: string; name: string; slug: string };
  invitation: { email: string; expiresAt: string };
  acceptUrl: string;
  emailSent: boolean;
}

const OVERVIEW_KEY = ["/api/admin/agencies/overview"] as const;
const VIEW_AS_KEY = "mediflow:view-as-org";

/** "Cascade Senior Advisors" → "cascade-senior-advisors" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

function AccessRestricted() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="font-display text-xl font-bold">Access Restricted</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Workspaces are managed by the platform owner. Your role does not have permission to view this page.
        </p>
        <Button asChild className="mt-6 w-full">
          <Link href="/dashboard">Return to Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}

export default function WorkspacesPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const isOwner = me?.role === "super_admin";
  const qc = useQueryClient();
  const { toast } = useToast();

  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => apiFetch<{ agencies: AgencyRow[] }>("/api/admin/agencies/overview"),
    enabled: isOwner,
  });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const [copied, setCopied] = useState(false);

  const totals = useMemo(() => {
    const rows = overview.data?.agencies ?? [];
    return {
      workspaces: rows.length,
      users: rows.reduce((s, r) => s + r.users, 0),
      clients: rows.reduce((s, r) => s + r.clients, 0),
    };
  }, [overview.data]);

  const create = useMutation({
    mutationFn: () =>
      apiFetch<CreateResult>("/api/admin/agencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim(), adminEmail: adminEmail.trim() }),
      }),
    onSuccess: async (result) => {
      setCreated(result);
      setName("");
      setSlug("");
      setSlugTouched(false);
      setAdminEmail("");
      await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      await qc.invalidateQueries({ queryKey: ["/api/admin/agencies"] });
      toast({
        title: "Workspace created",
        description: result.emailSent
          ? `${result.agency.name} is live. An invitation is on its way to ${result.invitation.email}.`
          : `${result.agency.name} is live. Email is not configured — copy the invitation link below.`,
      });
    },
    onError: (err: Error) => setFormError(err.message),
  });

  if (meLoading) return <Skeleton className="h-64" />;
  if (!isOwner) return <AccessRestricted />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    create.mutate();
  };

  const copyLink = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.acceptUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Select the link and copy it by hand.", variant: "destructive" });
    }
  };

  const viewAgency = (id: string) => {
    try {
      localStorage.setItem(VIEW_AS_KEY, id);
    } catch {
      return;
    }
    window.location.assign(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/dashboard`);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Workspaces"
        subtitle="Every agency on the platform. Provision a new one and invite its first administrator."
      >
        <Button variant="outline" onClick={() => void overview.refetch()} disabled={overview.isFetching}>
          {overview.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Agency workspaces" value={totals.workspaces} icon={Building2} color="navy" loading={overview.isLoading} />
        <KpiCard label="Active accounts" value={totals.users} icon={Users} color="blue" loading={overview.isLoading} />
        <KpiCard label="Clients under management" value={totals.clients} icon={ShieldCheck} color="green" loading={overview.isLoading} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <SectionCard title="All workspaces" description="Counts are live from each agency's records.">
          {overview.isError ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {(overview.error as Error & { data?: { error?: string } }).data?.error === "mfa_required"
                ? "Turn on multi-factor authentication in your account security to manage workspaces."
                : "Could not load workspaces. Refresh to try again."}
            </p>
          ) : overview.isLoading ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (overview.data?.agencies.length ?? 0) === 0 ? (
            <EmptyState icon={Building2} title="No workspaces yet" description="Create the first one on the right." compact />
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="px-3 py-2">Workspace</th>
                    <th className="px-3 py-2">Slug</th>
                    <th className="px-3 py-2 text-right">Accounts</th>
                    <th className="px-3 py-2 text-right">Agents</th>
                    <th className="px-3 py-2 text-right">Clients</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {overview.data!.agencies.map((a) => (
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
                      <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">{a.slug}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.users}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.agents}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.clients}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{new Date(a.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</td>
                      <td className="px-3 py-2.5 text-right">
                        {a.id !== me?.orgId && (
                          <Button size="sm" variant="ghost" onClick={() => viewAgency(a.id)} title="Open this agency read-only">
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

        <SectionCard
          title="Create a workspace"
          description="Creates the agency and invites its first administrator. They sign in with their own account — there are no shared or temporary passwords."
        >
          {created && (
            <div className="mb-4 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-semibold">
                <Check className="h-4 w-4 text-success" /> {created.agency.name} is live
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                <MailCheck className="h-3.5 w-3.5" />
                {created.emailSent ? "Invitation emailed to " : "Email not configured — send this link to "}
                <span className="font-mono text-xs text-foreground">{created.invitation.email}</span>
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Input readOnly value={created.acceptUrl} className="h-8 font-mono text-[11px]" aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" size="sm" variant="outline" onClick={() => void copyLink()}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Shown once — keep it until they have signed in. The link expires in 7 days.
              </p>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ws-name">Agency name</Label>
              <Input
                id="ws-name"
                value={name}
                maxLength={120}
                required
                placeholder="Cascade Senior Advisors"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ws-slug">Slug</Label>
              <Input
                id="ws-slug"
                value={slug}
                maxLength={48}
                required
                pattern="[a-z0-9]([a-z0-9\-]{1,46}[a-z0-9])"
                className="font-mono text-sm"
                placeholder="cascade-senior-advisors"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
              <p className="text-xs text-muted-foreground">Lowercase letters, digits and hyphens. Must be unique.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ws-email">First administrator's email</Label>
              <Input
                id="ws-email"
                type="email"
                value={adminEmail}
                maxLength={255}
                required
                autoComplete="off"
                placeholder="owner@cascadesenior.com"
                onChange={(e) => setAdminEmail(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">They get an Agency Admin invitation and create their own sign-in.</p>
            </div>
            {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
            <Button type="submit" className="w-full" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {create.isPending ? "Creating workspace…" : "Create workspace"}
            </Button>
          </form>
        </SectionCard>
      </div>
    </div>
  );
}
