/**
 * Agent Back Office (agencyBRIDGE AgentBackofficePage): one screen with an
 * agent's readiness score, AHIP, licenses, carrier certifications, carrier
 * portal accounts, open tasks, paperwork and checklists.
 *
 * Data: `GET /api/agents/me/backoffice` for the agent role (their own record
 * only) and `GET /api/agents/:id/backoffice` for staff, who pick an agent.
 * Every number is computed server-side from the real agent tables.
 */
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import {
  Award,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileCheck,
  FolderOpen,
  GraduationCap,
  MapPin,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { customFetch, useGetAgents, useGetMe } from "@workspace/api-client-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, KpiCard, PageHeader, SectionCard, StatusPill, type KpiColor } from "@/components/shared";
import { cn } from "@/lib/utils";

export type Backoffice = {
  agent: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    status: string;
    hireDate: string | null;
    npn: string | null;
    avatarUrl: string | null;
  };
  readiness: {
    readyToSell: boolean;
    blockers: string[];
    ahipCurrent: boolean;
    licensedStates: string[];
    certifiedCarriers: { carrierId: string; name: string | null }[];
    certificationYear: number;
  } | null;
  complianceScore: {
    totalScore: number;
    activeLicenses: number;
    totalLicenses: number;
    activeCertifications: number;
    totalCertifications: number;
    ahipCompleted: boolean;
    onboardingCompletedItems: number;
    onboardingTotalItems: number;
  };
  ahip: { id: string; certificationYear: number; status: string; score: number | null; completedDate: string | null }[];
  licenses: { id: string; stateCode: string; licenseType: string; status: string; expiryDate: string | null }[];
  certifications: {
    id: string;
    carrierName: string | null;
    certificationYear: number;
    status: string;
    completedDate: string | null;
    expiryDate: string | null;
  }[];
  portals: { id: string; platformName: string; platformCategory: string | null; status: string; provisionedAt: string | null }[];
  tasks: { id: string; title: string; dueDate: string | null; priority: string; status: string }[];
  documents: { id: string; name: string; category: string; createdAt: string }[];
  checklists: {
    id: string;
    type: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    totalItems: number;
    completedItems: number;
  }[];
};

const STAFF_ROLES = ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"];

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

function initials(first: string, last: string): string {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

function scoreMessage(score: number): string {
  if (score >= 90) return "Ready to go — everything is in order";
  if (score >= 70) return "Nearly ready — a few items to resolve";
  if (score >= 40) return "Getting there — several items still open";
  return "Just getting started — work through the list below";
}

export default function AgentBackofficePage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const role = me?.role ?? "";
  const isStaff = STAFF_ROLES.includes(role);
  const search = useSearch();
  const initialId = new URLSearchParams(search).get("agent") ?? "";
  const [selectedId, setSelectedId] = useState(initialId);

  const { data: agentsData, isLoading: agentsLoading } = useGetAgents(
    { limit: 200, sortBy: "name" },
    { query: { enabled: isStaff, queryKey: ["/api/agents", "backoffice-picker"] } },
  );
  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData]);

  useEffect(() => {
    if (isStaff && !selectedId && agents.length > 0) setSelectedId(agents[0]!.id);
  }, [isStaff, selectedId, agents]);

  const url = isStaff ? (selectedId ? `/api/agents/${selectedId}/backoffice` : null) : role ? "/api/agents/me/backoffice" : null;
  const bo = useQuery({
    queryKey: [url],
    queryFn: () => customFetch<Backoffice>(url!),
    enabled: Boolean(url),
    retry: false,
  });

  const pickAgent = (id: string) => {
    setSelectedId(id);
    const u = new URL(window.location.href);
    u.searchParams.set("agent", id);
    window.history.replaceState(null, "", u.toString());
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title={isStaff ? "Agent Back Office" : "My Back Office"}
        subtitle="AHIP, licenses, carrier certifications, portal access and open to-dos — everything an agent needs to be ready to sell"
      >
        {isStaff && agents.length > 0 && (
          <Select value={selectedId} onValueChange={pickAgent}>
            <SelectTrigger className="w-[240px]" aria-label="Choose an agent">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.firstName} {a.lastName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </PageHeader>

      {meLoading || agentsLoading || (bo.isLoading && Boolean(url)) ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        </div>
      ) : isStaff && agents.length === 0 ? (
        <SectionCard>
          <EmptyState icon={Building2} title="No agents yet" description="Add your first agent and their back office will appear here." action={{ label: "Go to Agents", href: "/agents" }} />
        </SectionCard>
      ) : bo.isError ? (
        <SectionCard>
          <EmptyState
            icon={ShieldCheck}
            title={isStaff ? "Couldn't load this agent" : "Your agent profile isn't linked yet"}
            description={isStaff ? "Please pick the agent again or refresh the page." : "Ask your agency administrator to connect your sign-in to your agent record."}
          />
        </SectionCard>
      ) : bo.data ? (
        <BackofficeView data={bo.data} isStaff={isStaff} />
      ) : null}
    </div>
  );
}

export function BackofficeView({ data, isStaff }: { data: Backoffice; isStaff: boolean }) {
  const { agent, readiness, complianceScore: score } = data;
  const now = new Date();
  const score100 = Math.round(score.totalScore);
  const overdue = data.tasks.filter((t) => t.dueDate && new Date(t.dueDate) < now).length;
  const highPriority = data.tasks.filter((t) => t.priority === "high" || t.priority === "urgent").length;
  const expiringSoon =
    data.licenses.filter((l) => l.expiryDate && differenceInCalendarDays(parseISO(l.expiryDate), now) >= 0 && differenceInCalendarDays(parseISO(l.expiryDate), now) <= 60).length +
    data.certifications.filter((c) => c.expiryDate && differenceInCalendarDays(parseISO(c.expiryDate), now) >= 0 && differenceInCalendarDays(parseISO(c.expiryDate), now) <= 60).length;
  const provisioned = data.portals.filter((p) => p.status === "provisioned").length;
  // Same test as the Ready-to-Sell gate: active AND not past its expiry date.
  const pastExpiry = data.licenses.filter((l) => l.expiryDate && new Date(l.expiryDate) < now).length;
  const currentLicenses = data.licenses.filter(
    (l) => l.status === "active" && (!l.expiryDate || new Date(l.expiryDate) >= now),
  ).length;
  const latestAhip = data.ahip[0];
  const ahipColor: KpiColor = score.ahipCompleted ? "green" : "orange";
  const tone = (done: number, total: number): KpiColor => (total > 0 && done >= total ? "green" : "orange");

  return (
    <>
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-4 bg-gradient-to-br from-navy-800 via-navy-700 to-navy-600 p-6 text-white sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <Avatar className="h-14 w-14 border-2 border-white/30">
              {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
              <AvatarFallback className="bg-white/15 text-white font-semibold">{initials(agent.firstName, agent.lastName)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-bold tracking-tight truncate">{agent.firstName} {agent.lastName}</h2>
              <p className="text-sm text-white/75 truncate">
                {agent.email}
                {agent.npn ? ` · NPN ${agent.npn}` : " · NPN not on file"}
                {agent.hireDate ? ` · since ${fmt(agent.hireDate)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold capitalize">{agent.status.replace(/_/g, " ")}</span>
            {readiness && (
              <span className={cn("rounded-full px-3 py-1 text-xs font-semibold", readiness.readyToSell ? "bg-success text-white" : "bg-white/15")}>
                {readiness.readyToSell ? "Ready to sell" : "Not ready to sell yet"}
              </span>
            )}
            {isStaff && (
              <Link href={`/agents/${agent.id}`} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-navy-800 hover:bg-white/90">
                Full profile
              </Link>
            )}
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div className="flex flex-col gap-4 rounded-xl border border-warning/30 bg-gradient-to-r from-warning/10 to-warning/5 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" title="Licenses 40% · certifications 30% · AHIP 20% · onboarding 10% — the same score as on the agent profile">
                Compliance score
              </p>
              <p className="font-display text-5xl font-bold text-warning leading-tight">
                {score100}<span className="text-xl font-semibold text-muted-foreground"> / 100</span>
              </p>
              <p className="text-sm text-muted-foreground">{scoreMessage(score100)}</p>
              <Progress value={score100} className="mt-2 h-2 w-full sm:w-72" />
            </div>
            <div className="grid grid-cols-3 gap-6 text-center">
              <Stat value={data.tasks.length} label="Open tasks" />
              <Stat value={overdue} label="Overdue" danger={overdue > 0} />
              <Stat value={expiringSoon} label="Expiring in 60 days" danger={expiringSoon > 0} />
            </div>
          </div>

          {readiness && readiness.blockers.length > 0 && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm">
              <span className="font-semibold text-destructive">What's stopping sales: </span>
              {readiness.blockers.join(" · ")}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <KpiCard label="AHIP" value={score.ahipCompleted ? "Passed" : latestAhip ? latestAhip.status.replace(/_/g, " ") : "Not started"}
              icon={GraduationCap} color={ahipColor} hint={`For ${readiness?.certificationYear ?? now.getFullYear()}`} />
            <KpiCard label="Licenses" value={`${currentLicenses}/${data.licenses.length}`} icon={MapPin}
              color={tone(currentLicenses, data.licenses.length)}
              hint={pastExpiry > 0 ? `${pastExpiry} past the expiry date` : "Active and in date"} />
            <KpiCard label="Certifications" value={`${score.activeCertifications}/${score.totalCertifications}`} icon={Award}
              color={tone(score.activeCertifications, score.totalCertifications)} hint="Passed of total" />
            <KpiCard label="Portal access" value={`${provisioned}/${data.portals.length}`} icon={Building2}
              color={tone(provisioned, data.portals.length)} hint="Accounts set up" />
          </div>
        </div>
      </section>

      <Tabs defaultValue="tasks">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="tasks">Open tasks ({data.tasks.length}){highPriority > 0 ? ` · ${highPriority} high` : ""}</TabsTrigger>
          <TabsTrigger value="ahip">AHIP</TabsTrigger>
          <TabsTrigger value="licenses">Licenses</TabsTrigger>
          <TabsTrigger value="certs">Certifications</TabsTrigger>
          <TabsTrigger value="portals">Carrier portals</TabsTrigger>
          <TabsTrigger value="docs">Paperwork</TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="mt-4">
          <SectionCard title="Open tasks & action items" icon={ClipboardList} description="Soonest due first.">
            {data.tasks.length === 0 ? (
              <EmptyState compact icon={CheckCircle2} title="Nothing to do right now" description="New tasks for this agent will show up here." />
            ) : (
              <ul className="space-y-2">
                {data.tasks.map((t) => {
                  const late = t.dueDate ? new Date(t.dueDate) < now : false;
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", late ? "bg-destructive" : "bg-warning")} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{t.title}</p>
                          <p className={cn("text-xs", late ? "text-destructive font-medium" : "text-muted-foreground")}>
                            {t.dueDate ? `Due ${fmt(t.dueDate)}${late ? " · overdue" : ""}` : "No due date"}
                          </p>
                        </div>
                      </div>
                      <StatusPill tone={t.priority === "urgent" || t.priority === "high" ? "danger" : t.priority === "medium" ? "warning" : "neutral"}>
                        {t.priority}
                      </StatusPill>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="ahip" className="mt-4">
          <SectionCard title="AHIP certification" icon={GraduationCap} description="The yearly Medicare training every agent needs before selling.">
            {data.ahip.length === 0 ? (
              <EmptyState compact icon={GraduationCap} title="No AHIP record yet" description="Once AHIP is recorded for this agent, the result shows here." />
            ) : (
              <SimpleList rows={data.ahip.map((a) => ({
                key: a.id,
                icon: a.status === "passed" ? CheckCircle2 : Clock,
                ok: a.status === "passed",
                title: `AHIP ${a.certificationYear}`,
                detail: a.completedDate ? `Completed ${fmt(a.completedDate)}${a.score != null ? ` · score ${a.score}` : ""}` : "Not completed",
                status: a.status,
              }))} />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="licenses" className="mt-4">
          <SectionCard title="State licenses" icon={MapPin} action={{ label: "Licensing", href: "/licensing" }}>
            {data.licenses.length === 0 ? (
              <EmptyState compact icon={MapPin} title="No licenses on file" description="Add the agent's state licenses on the Licensing page." />
            ) : (
              <SimpleList rows={data.licenses.map((l) => {
                const expired = Boolean(l.expiryDate && new Date(l.expiryDate) < now);
                const ok = l.status === "active" && !expired;
                return {
                  key: l.id,
                  icon: ok ? CheckCircle2 : XCircle,
                  ok,
                  title: `${l.stateCode} · ${l.licenseType}`,
                  detail: l.expiryDate ? `${expired ? "Expired" : "Expires"} ${fmt(l.expiryDate)}` : "No expiry date on file",
                  status: expired ? "expired" : l.status,
                };
              })} />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="certs" className="mt-4">
          <SectionCard title="Carrier certifications" icon={Award} action={{ label: "Certifications", href: "/certifications" }}>
            {data.certifications.length === 0 ? (
              <EmptyState compact icon={Award} title="No carrier certifications yet" description="Each carrier's yearly certification shows here once recorded." />
            ) : (
              <SimpleList rows={data.certifications.map((c) => ({
                key: c.id,
                icon: c.status === "passed" ? CheckCircle2 : Clock,
                ok: c.status === "passed",
                title: `${c.carrierName ?? "Carrier"} ${c.certificationYear}`,
                detail: c.expiryDate ? `Expires ${fmt(c.expiryDate)}` : c.completedDate ? `Completed ${fmt(c.completedDate)}` : "Not completed",
                status: c.status,
              }))} />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="portals" className="mt-4">
          <SectionCard title="Carrier portals & tools" icon={Building2} description="The systems this agent needs an account for.">
            {data.portals.length === 0 ? (
              <EmptyState compact icon={Building2} title="No portal accounts tracked" description="Track carrier portals and tools on the agent's profile, under Tech stack." />
            ) : (
              <SimpleList rows={data.portals.map((p) => ({
                key: p.id,
                icon: p.status === "provisioned" ? CheckCircle2 : Clock,
                ok: p.status === "provisioned",
                title: p.platformName,
                detail: p.platformCategory ? p.platformCategory.replace(/_/g, " ") : "Tool",
                status: p.status === "provisioned" ? "active" : p.status,
                statusLabel: p.status === "provisioned" ? "Set up" : p.status === "pending" ? "Waiting" : "Removed",
              }))} />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="docs" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SectionCard title="Paperwork on file" icon={FolderOpen}>
              {data.documents.length === 0 ? (
                <EmptyState compact icon={FolderOpen} title="No documents yet" description="E&O, W-9 and other agent paperwork appears here once uploaded." />
              ) : (
                <SimpleList rows={data.documents.map((d) => ({
                  key: d.id, icon: FileCheck, ok: true, title: d.name, detail: `Uploaded ${fmt(d.createdAt)}`, status: d.category, statusLabel: d.category.replace(/_/g, " "),
                }))} />
              )}
            </SectionCard>
            <SectionCard title="Checklists" icon={ClipboardList}>
              {data.checklists.length === 0 ? (
                <EmptyState compact icon={ClipboardList} title="No checklists started" description="Onboarding and offboarding checklists show their progress here." />
              ) : (
                <ul className="space-y-3">
                  {data.checklists.map((c) => {
                    const pct = c.totalItems > 0 ? Math.round((c.completedItems / c.totalItems) * 100) : 0;
                    return (
                      <li key={c.id} className="rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium capitalize">{c.type} checklist</p>
                          <StatusPill status={c.status} />
                        </div>
                        <Progress value={pct} className="mt-2 h-2" />
                        <p className="mt-1 text-xs text-muted-foreground">{c.completedItems} of {c.totalItems} steps done · started {fmt(c.startedAt)}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Stat({ value, label, danger }: { value: number; label: string; danger?: boolean }) {
  return (
    <div>
      <p className={cn("font-display text-2xl font-bold", danger ? "text-destructive" : "text-foreground")}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function SimpleList({
  rows,
}: {
  rows: { key: string; icon: ComponentType<{ className?: string }>; ok: boolean; title: string; detail: string; status: string; statusLabel?: string }[];
}) {
  return (
    <ul className="divide-y divide-border">
      {rows.map(({ key, icon: Icon, ok, title, detail, status, statusLabel }) => (
        <li key={key} className="flex items-center justify-between gap-3 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <Icon className={cn("h-4 w-4 shrink-0", ok ? "text-success" : "text-warning")} />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{title}</p>
              <p className="text-xs text-muted-foreground truncate">{detail}</p>
            </div>
          </div>
          <StatusPill status={status}>{statusLabel}</StatusPill>
        </li>
      ))}
    </ul>
  );
}
