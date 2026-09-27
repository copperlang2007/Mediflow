import { useMemo } from "react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import {
  useGetMe,
  useGetDashboardStats,
  useGetDashboardActivity,
  useGetRenewals,
  getGetRenewalsQueryKey,
  useGetTasks,
  getGetTasksQueryKey,
  useGetContacts,
  getGetContactsQueryKey,
  useGetDeals,
  getGetDealsQueryKey,
  useGetRetentionSummary,
  getGetRetentionSummaryQueryKey,
  type GetContactsParams,
} from "@workspace/api-client-react";
import {
  Activity,
  AlertTriangle,
  Award,
  BookOpen,
  CalendarClock,
  CheckSquare,
  Clock,
  FileText,
  FolderOpen,
  HeartPulse,
  PhoneCall,
  PieChart as PieIcon,
  PlusCircle,
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  UserCog,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, formatDistanceToNow, startOfMonth, subMonths } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { KpiCard, MiniStat } from "@/components/shared/KpiCard";
import { SectionCard } from "@/components/shared/SectionCard";
import { StatusPill } from "@/components/shared/StatusPill";
import { EmptyState } from "@/components/shared/EmptyState";
import { visibleNavGroups, type Role } from "@/components/layout/nav-config";

/*
 * Dashboard — agencyBRIDGE layout, Mediflow data.
 *
 * Every number on this page comes from an existing Mediflow API endpoint:
 *   GET /api/dashboard/stats      agents, licenses, tasks, leads, AHIP, contacts
 *   GET /api/dashboard/activity   recent activity feed
 *   GET /api/renewals?days=30     license + certification renewals due
 *   GET /api/tasks                due dates for "due this week"
 *   GET /api/contacts             totals per status + created dates (trend)
 *   GET /api/deals?status=won     won dates (trend)
 *   GET /api/retention/summary    at-risk clients
 * Queries a role is not allowed to make (see api-server lib/permissions.ts)
 * are never sent; the card falls back to a dashboard-stats number instead.
 * Nothing here is hard-coded or randomised.
 */

// Roles allowed by the server for each resource (permissions.ts).
const CAN_READ_CONTACTS: Role[] = [
  "super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer",
];
const CAN_READ_TASKS = CAN_READ_CONTACTS; // task_instance.read
const CAN_READ_AGENTS = CAN_READ_CONTACTS; // agent.read (GET /renewals)
const CAN_READ_RETENTION = CAN_READ_CONTACTS; // GET /retention/summary uses contact.read

const AGENT_STATUS_COLORS: Record<string, string> = {
  active: "#22a05a",
  onboarding: "#3b6fa0",
  suspended: "#dc2626",
  offboarding: "#f59e0b",
  offboarded: "#94a3b8",
};

const BOOK_SEGMENTS = [
  { status: "lead", label: "Leads", color: "#0f1b3d" },
  { status: "prospect", label: "Prospects", color: "#3b6fa0" },
  { status: "enrolled", label: "Enrolled", color: "#22a05a" },
  { status: "retained", label: "Retained", color: "#8fb0d4" },
] as const;

type QuickAction = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; description: string };

const QUICK_ACTIONS: Record<string, QuickAction[]> = {
  super_admin: [
    { label: "Add an agent", href: "/agents", icon: UserPlus, description: "Start onboarding someone new" },
    { label: "Create a task", href: "/tasks", icon: PlusCircle, description: "Assign a follow-up" },
    { label: "Audit log", href: "/compliance", icon: ShieldCheck, description: "See who changed what" },
    { label: "Settings", href: "/settings", icon: Settings, description: "Agency details and preferences" },
  ],
  agency_admin: [
    { label: "Add an agent", href: "/agents", icon: UserPlus, description: "Start onboarding someone new" },
    { label: "Create a task", href: "/tasks", icon: PlusCircle, description: "Assign a follow-up" },
    { label: "Audit log", href: "/compliance", icon: ShieldCheck, description: "See who changed what" },
    { label: "Settings", href: "/settings", icon: Settings, description: "Agency details and preferences" },
  ],
  compliance_manager: [
    { label: "Licenses", href: "/licensing", icon: FileText, description: "Review state licenses" },
    { label: "Certifications", href: "/certifications", icon: Award, description: "Check certification status" },
    { label: "Audit log", href: "/compliance", icon: ShieldCheck, description: "Export the audit trail" },
    { label: "Documents", href: "/documents", icon: FolderOpen, description: "Compliance paperwork" },
  ],
  agent_support: [
    { label: "Agents", href: "/agents", icon: Users, description: "Browse the agent roster" },
    { label: "Create a task", href: "/tasks", icon: PlusCircle, description: "Assign a follow-up" },
    { label: "Clients & Leads", href: "/crm", icon: PhoneCall, description: "Look up a client" },
    { label: "Documents", href: "/documents", icon: FolderOpen, description: "View documents" },
  ],
  viewer: [
    { label: "Agents", href: "/agents", icon: Users, description: "View the agent roster" },
    { label: "Licenses", href: "/licensing", icon: FileText, description: "View licenses" },
    { label: "Tasks", href: "/tasks", icon: CheckSquare, description: "View the task list" },
    { label: "Documents", href: "/documents", icon: FolderOpen, description: "View documents" },
  ],
  agent: [
    { label: "My tasks", href: "/tasks", icon: CheckSquare, description: "What's assigned to you" },
    { label: "My licenses", href: "/licensing", icon: FileText, description: "Your state licenses" },
    { label: "Certifications", href: "/certifications", icon: Award, description: "Your certifications" },
    { label: "Training", href: "/documents", icon: BookOpen, description: "Training materials" },
  ],
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Total count for one contact status (asks for 1 row; reads `total`). */
function useContactCount(status: string, enabled: boolean) {
  const params: GetContactsParams = { status, limit: 1 };
  const q = useGetContacts(params, {
    query: { queryKey: getGetContactsQueryKey(params), enabled, staleTime: 60_000 },
  });
  return { count: q.data?.total, loading: q.isLoading && enabled };
}

const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  fontSize: 13,
};

export default function Dashboard() {
  const { user } = useUser();
  const { data: me } = useGetMe();
  const role = (me?.role ?? null) as Role | null;
  const roleKnown = role !== null;

  const canContacts = roleKnown && CAN_READ_CONTACTS.includes(role);
  const canTasks = roleKnown && CAN_READ_TASKS.includes(role);
  const canRenewals = roleKnown && CAN_READ_AGENTS.includes(role);
  const canRetention = roleKnown && CAN_READ_RETENTION.includes(role);

  // Only link a card to a page this role can actually open.
  const visibleHrefs = useMemo(() => {
    const set = new Set<string>();
    for (const g of visibleNavGroups(role)) for (const i of g.items) set.add(i.href);
    return set;
  }, [role]);
  const linkIf = (href: string) => (roleKnown && visibleHrefs.has(href) ? href : undefined);

  // ---- Queries (all existing endpoints) -----------------------------------
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: activity = [], isLoading: activityLoading } = useGetDashboardActivity({ limit: 15 });

  const renewalParams = { days: 30 };
  const renewalsQ = useGetRenewals(renewalParams, {
    query: { queryKey: getGetRenewalsQueryKey(renewalParams), enabled: canRenewals, staleTime: 60_000, retry: 1 },
  });

  const taskParams = { limit: 1000 };
  const tasksQ = useGetTasks(taskParams, {
    query: { queryKey: getGetTasksQueryKey(taskParams), enabled: canTasks, staleTime: 60_000, retry: 1 },
  });

  const trendContactParams: GetContactsParams = { limit: 1000, sortBy: "createdAt", sortDir: "desc" };
  const trendContactsQ = useGetContacts(trendContactParams, {
    query: { queryKey: getGetContactsQueryKey(trendContactParams), enabled: canContacts, staleTime: 60_000, retry: 1 },
  });
  const wonParams = { status: "won", limit: 500 };
  const wonDealsQ = useGetDeals(wonParams, {
    query: { queryKey: getGetDealsQueryKey(wonParams), enabled: canContacts, staleTime: 60_000, retry: 1 },
  });

  const retentionQ = useGetRetentionSummary({
    query: { queryKey: getGetRetentionSummaryQueryKey(), enabled: canRetention, staleTime: 60_000, retry: 1 },
  });

  const leadCount = useContactCount("lead", canContacts);
  const prospectCount = useContactCount("prospect", canContacts);
  const enrolledCount = useContactCount("enrolled", canContacts);
  const retainedCount = useContactCount("retained", canContacts);

  // ---- Derived numbers -----------------------------------------------------
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const tasksDueThisWeek = useMemo(() => {
    const tasks = tasksQ.data?.tasks;
    if (!tasks) return undefined;
    return tasks.filter((t) => {
      if (t.status !== "open" && t.status !== "in_progress") return false;
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      return d >= now && d <= weekAhead;
    }).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksQ.data]);

  // Prefer the renewals endpoint (licenses + certifications). If this role cannot
  // call it, or it fails, fall back to licenses expiring in 30 days from stats.
  const renewalsFromApi = canRenewals && renewalsQ.data ? renewalsQ.data.total : undefined;
  const renewalsDue = renewalsFromApi ?? stats?.licensesExpiringIn30Days;
  const renewalsHint = renewalsFromApi !== undefined ? "Licenses & certifications" : "Licenses expiring";
  const openTasks = stats?.openTasksCount ?? 0;
  const overdue = stats?.overdueTasks ?? 0;

  const firstName = user?.firstName || me?.fullName?.split(" ")[0] || "there";

  // Monthly trend for the last 6 months: new contacts added, deals won.
  const trend = useMemo(() => {
    const months = Array.from({ length: 6 }, (_, i) => startOfMonth(subMonths(now, 5 - i)));
    const buckets = months.map((m) => ({ key: format(m, "yyyy-MM"), month: format(m, "MMM"), contacts: 0, won: 0 }));
    const idx = new Map(buckets.map((b, i) => [b.key, i]));
    for (const c of trendContactsQ.data?.data ?? []) {
      const i = idx.get(format(new Date(c.createdAt), "yyyy-MM"));
      if (i !== undefined) buckets[i]!.contacts++;
    }
    for (const row of wonDealsQ.data ?? []) {
      const deal = (row as { deal?: { wonAt?: string | null } }).deal;
      if (!deal?.wonAt) continue;
      const i = idx.get(format(new Date(deal.wonAt), "yyyy-MM"));
      if (i !== undefined) buckets[i]!.won++;
    }
    return buckets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendContactsQ.data, wonDealsQ.data]);
  const trendTruncated =
    (trendContactsQ.data?.total ?? 0) > (trendContactsQ.data?.data.length ?? 0);
  const trendEmpty = trend.every((b) => b.contacts === 0 && b.won === 0);
  const trendLoading = canContacts && (trendContactsQ.isLoading || wonDealsQ.isLoading);

  const bookSegments = BOOK_SEGMENTS.map((seg, i) => ({
    ...seg,
    value: [leadCount, prospectCount, enrolledCount, retainedCount][i]!.count ?? 0,
  }));
  const bookKnown = bookSegments.reduce((s, x) => s + x.value, 0);
  const bookOther = Math.max(0, (stats?.totalContacts ?? 0) - bookKnown);
  const bookData = [
    ...bookSegments,
    ...(bookOther > 0 ? [{ status: "other", label: "Other (lost / do not contact)", color: "#c2d4ea", value: bookOther }] : []),
  ].filter((d) => d.value > 0);
  const bookLoading = leadCount.loading || prospectCount.loading || enrolledCount.loading || retainedCount.loading || statsLoading;

  const agentPieData = stats
    ? Object.entries(stats.agentsByStatus)
        .map(([status, value]) => ({ status, value, color: AGENT_STATUS_COLORS[status] ?? "#94a3b8" }))
        .filter((d) => d.value > 0)
    : [];

  const quickActions = QUICK_ACTIONS[role ?? "viewer"] ?? QUICK_ACTIONS.viewer!;

  // Hero sentence — plain English, real numbers only.
  const taskPhrase =
    tasksDueThisWeek !== undefined
      ? `${plural(tasksDueThisWeek, "task")} due this week`
      : `${plural(openTasks, "open task")}`;
  const renewalPhrase =
    renewalsDue === undefined
      ? null
      : renewalsFromApi !== undefined
        ? plural(renewalsDue, "license or certification renewal", "license and certification renewals")
        : plural(renewalsDue, "license renewal");

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Welcome hero */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy-800 via-navy-700 to-navy-600 p-6 lg:p-8 text-white shadow-lg">
        <div className="relative z-10 max-w-2xl">
          <h2 className="text-sm font-medium text-white/70 mb-1 font-body tracking-normal">
            Dashboard · {format(now, "EEEE, MMMM d, yyyy")}
          </h2>
          <h1 className="font-display text-3xl font-bold tracking-tight mb-2">Welcome back, {firstName}</h1>
          {statsLoading ? (
            <Skeleton className="h-5 w-80 bg-white/20" />
          ) : (
            <p className="text-white/85 text-base">
              You have <span className="font-semibold text-white">{taskPhrase}</span>
              {renewalPhrase && (
                <>
                  {" "}and <span className="font-semibold text-white">{renewalPhrase}</span> due in the next 30 days
                </>
              )}
              .
              {overdue > 0 && (
                <>
                  {" "}
                  <Link href="/tasks" className="underline underline-offset-2 font-semibold text-amber-200 hover:text-amber-100">
                    {plural(overdue, "task is", "tasks are")} overdue
                  </Link>
                  .
                </>
              )}
            </p>
          )}
        </div>
        <div aria-hidden="true" className="absolute right-0 top-0 h-full w-1/2 opacity-10">
          <div className="absolute right-10 top-10 h-40 w-40 rounded-full bg-white blur-3xl" />
          <div className="absolute right-32 bottom-0 h-32 w-32 rounded-full bg-white blur-2xl" />
        </div>
      </section>

      {/* Headline KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Clients & Leads"
          value={(stats?.totalContacts ?? 0).toLocaleString()}
          hint={`${plural(stats?.openLeadsCount ?? 0, "open lead")}`}
          icon={Users}
          color="navy"
          loading={statsLoading}
          href={linkIf("/crm")}
        />
        <KpiCard
          label="Renewals due (30 days)"
          value={(renewalsDue ?? 0).toLocaleString()}
          hint={renewalsHint}
          icon={CalendarClock}
          color="blue"
          loading={statsLoading || (canRenewals && renewalsQ.isLoading)}
          href={linkIf("/renewals") ?? linkIf("/licensing")}
        />
        <KpiCard
          label="Active agents"
          value={(stats?.agentsByStatus.active ?? 0).toLocaleString()}
          hint={`${plural(stats?.totalAgents ?? 0, "agent")} on the team`}
          icon={UserCog}
          color="green"
          loading={statsLoading}
          href={linkIf("/agents")}
        />
        <KpiCard
          label="Open tasks"
          value={openTasks.toLocaleString()}
          hint={overdue > 0 ? `${overdue.toLocaleString()} overdue` : "Nothing overdue"}
          icon={CheckSquare}
          color="orange"
          loading={statsLoading}
          href={linkIf("/tasks")}
        />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MiniStat
          label="Open leads"
          value={(stats?.openLeadsCount ?? 0).toLocaleString()}
          icon={Target}
          loading={statsLoading}
          href={linkIf("/crm")}
        />
        <MiniStat
          label="Licenses expiring (90 days)"
          value={(stats?.licensesExpiringIn90Days ?? 0).toLocaleString()}
          icon={FileText}
          loading={statsLoading}
          tone={(stats?.licensesExpiringIn30Days ?? 0) > 0 ? "warning" : "default"}
          href={linkIf("/licensing")}
        />
        <MiniStat
          label={`AHIP complete (${now.getFullYear()})`}
          value={`${stats?.ahipCompletionRateCurrent ?? 0}%`}
          icon={Award}
          loading={statsLoading}
          href={linkIf("/certifications")}
        />
        {canRetention && !retentionQ.isError ? (
          <MiniStat
            label="Clients at risk"
            value={(retentionQ.data?.atRiskContacts ?? 0).toLocaleString()}
            icon={HeartPulse}
            loading={retentionQ.isLoading}
            tone={(retentionQ.data?.atRiskContacts ?? 0) > 0 ? "danger" : "default"}
            href={linkIf("/churn") ?? linkIf("/crm")}
          />
        ) : (
          <MiniStat
            label="Unread notifications"
            value={(stats?.unreadNotificationsCount ?? 0).toLocaleString()}
            icon={AlertTriangle}
            loading={statsLoading}
          />
        )}
      </div>

      {/* Quick actions */}
      <SectionCard title="Quick actions" description="Common jobs, one click away">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.href + action.label}
                href={action.href}
                className="group flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:border-accent/40 hover:bg-muted/50"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{action.label}</span>
                  <span className="block text-xs text-muted-foreground truncate">{action.description}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </SectionCard>

      {/* Charts */}
      {canContacts && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SectionCard
            className="lg:col-span-2"
            title="Growth over the last 6 months"
            description={
              trendTruncated
                ? "New clients & leads added, and deals won (based on your 1,000 most recent contacts)"
                : "New clients & leads added, and deals won, each month"
            }
            action={{ label: "Open Clients & Leads", href: "/crm" }}
          >
            {trendLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : trendEmpty ? (
              <EmptyState
                icon={TrendingUp}
                title="No new clients or won deals in the last 6 months"
                description="As you add clients and close deals, you'll see the trend here."
                action={{ label: "Add a client", href: "/crm" }}
              />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#3b6fa0]" /> Clients & leads added</span>
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#22a05a]" /> Deals won</span>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={trend} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashContactsGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b6fa0" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b6fa0" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="dashWonGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22a05a" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#22a05a" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Area type="monotone" name="Clients & leads added" dataKey="contacts" stroke="#3b6fa0" strokeWidth={2.5} fill="url(#dashContactsGrad)" />
                    <Area type="monotone" name="Deals won" dataKey="won" stroke="#22a05a" strokeWidth={2.5} fill="url(#dashWonGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              </>
            )}
          </SectionCard>

          <SectionCard title="Your book" description="Clients & leads by stage">
            {bookLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : bookData.length === 0 ? (
              <EmptyState
                compact
                icon={PieIcon}
                title="No clients yet"
                description="Add your first client or lead to see your book here."
                action={{ label: "Add a client", href: "/crm" }}
              />
            ) : (
              <>
                <div className="relative">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={bookData} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="none">
                        {bookData.map((d) => (
                          <Cell key={d.status} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-display text-2xl font-bold">{(stats?.totalContacts ?? 0).toLocaleString()}</span>
                    <span className="text-xs text-muted-foreground">total</span>
                  </div>
                </div>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {bookData.map((d) => (
                    <li key={d.status} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="truncate text-muted-foreground">{d.label}</span>
                      </span>
                      <span className="font-semibold">{d.value.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </SectionCard>
        </div>
      )}

      {/* Team, AHIP, license alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Agent team" description="Where each agent stands" icon={Users}>
          {statsLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : !stats || stats.totalAgents === 0 ? (
            <EmptyState compact icon={Users} title="No agents yet" description="Agents you add will appear here with their status." />
          ) : (
            <div className="flex items-center gap-4">
              <PieChart width={112} height={112}>
                <Pie data={agentPieData} dataKey="value" nameKey="status" cx={52} cy={52} innerRadius={32} outerRadius={52} paddingAngle={3} stroke="none">
                  {agentPieData.map((d) => (
                    <Cell key={d.status} fill={d.color} />
                  ))}
                </Pie>
              </PieChart>
              <ul className="flex-1 min-w-0 space-y-1.5">
                {Object.entries(stats.agentsByStatus).map(([status, count]) => (
                  <li key={status} className="flex items-center justify-between gap-2">
                    <StatusPill status={status} />
                    <span className="text-sm font-semibold">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SectionCard>

        <SectionCard title={`AHIP ${now.getFullYear()}`} description="Share of agents who have passed this year" icon={Award}>
          {statsLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="flex items-end gap-2 mb-3">
                <span className="font-display text-4xl font-bold">{stats?.ahipCompletionRateCurrent ?? 0}%</span>
                <span className="text-sm text-muted-foreground mb-1.5">complete</span>
              </div>
              <Progress value={stats?.ahipCompletionRateCurrent ?? 0} className="h-2.5" />
              <p className="text-sm text-muted-foreground mt-3">
                {stats?.ahipCompletionRateCurrent === 100
                  ? "Every agent is certified for this year."
                  : "Agents need AHIP before they can sell Medicare Advantage and Part D."}
              </p>
            </>
          )}
        </SectionCard>

        <SectionCard
          title="License alerts"
          description="Expiring in the next 90 days"
          icon={AlertTriangle}
          iconClassName="text-warning"
        >
          {statsLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (stats?.agentsWithExpiringLicenses ?? []).length === 0 ? (
            <EmptyState compact icon={ShieldCheck} title="All clear" description="No licenses expire in the next 90 days." />
          ) : (
            <ul className="space-y-2">
              {(stats?.agentsWithExpiringLicenses ?? []).slice(0, 4).map((alert, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{alert.agentName}</p>
                    <p className="text-xs text-muted-foreground">
                      {alert.stateCode} · {alert.licenseType}
                    </p>
                  </div>
                  <StatusPill tone={alert.daysUntilExpiry <= 30 ? "danger" : alert.daysUntilExpiry <= 60 ? "warning" : "neutral"}>
                    {alert.daysUntilExpiry} days
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Activity */}
      <SectionCard title="Recent activity" description="The latest calls, notes and updates across the agency" icon={Activity}>
        {activityLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : activity.length === 0 ? (
          <EmptyState compact icon={Clock} title="Nothing yet" description="Calls, notes and other updates will show up here as your team works." />
        ) : (
          <ul className="divide-y divide-border">
            {activity.map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-accent">
                  <Activity className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{item.title}</p>
                  {(item.userFullName || (item.description && item.description !== item.title)) && (
                    <p className="text-xs text-muted-foreground truncate">
                      {[item.userFullName, item.description !== item.title ? item.description : null].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
