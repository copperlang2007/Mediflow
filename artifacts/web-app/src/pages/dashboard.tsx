import { useGetDashboardStats, useGetDashboardActivity } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Users,
  FileText,
  Award,
  CheckSquare,
  PhoneCall,
  AlertTriangle,
  TrendingUp,
  Bell,
  Clock,
  Activity,
  ShieldCheck,
  FolderOpen,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { formatDistanceToNow, format } from "date-fns";
import { useGetMe } from "@workspace/api-client-react";
import { Link } from "wouter";
import { UserPlus, PlusCircle, Settings, BookOpen } from "lucide-react";
import { sellingPlanYear } from "@/lib/planYear";

const STATUS_COLORS: Record<string, string> = {
  onboarding: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  suspended: "bg-red-100 text-red-800",
  offboarding: "bg-orange-100 text-orange-800",
  offboarded: "bg-slate-100 text-slate-600",
};

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  loading,
  variant = "default",
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  loading?: boolean;
  variant?: "default" | "warning" | "danger";
}) {
  return (
    <Card
      className={
        variant === "warning"
          ? "border-amber-200 bg-amber-50"
          : variant === "danger"
          ? "border-red-200 bg-red-50"
          : ""
      }
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground font-medium">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-20 mt-1" />
            ) : (
              <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
            )}
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
          </div>
          <div
            className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ml-3 ${
              variant === "warning"
                ? "bg-amber-100"
                : variant === "danger"
                ? "bg-red-100"
                : "bg-primary/10"
            }`}
          >
            <Icon
              className={`h-5 w-5 ${
                variant === "warning"
                  ? "text-amber-600"
                  : variant === "danger"
                  ? "text-red-600"
                  : "text-primary"
              }`}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

type Role = "super_admin" | "agency_admin" | "compliance_manager" | "agent_support" | "viewer" | "agent";

type QuickAction = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; description: string };

const QUICK_ACTIONS: Record<string, QuickAction[]> = {
  super_admin: [
    { label: "Add Agent", href: "/agents", icon: UserPlus, description: "Onboard a new agent" },
    { label: "Create Task", href: "/tasks", icon: PlusCircle, description: "Assign a task" },
    { label: "Audit Log", href: "/compliance", icon: ShieldCheck, description: "Review activity" },
    { label: "Settings", href: "/settings", icon: Settings, description: "Manage org settings" },
  ],
  agency_admin: [
    { label: "Add Agent", href: "/agents", icon: UserPlus, description: "Onboard a new agent" },
    { label: "Create Task", href: "/tasks", icon: PlusCircle, description: "Assign a task" },
    { label: "Audit Log", href: "/compliance", icon: ShieldCheck, description: "Review activity" },
    { label: "Settings", href: "/settings", icon: Settings, description: "Manage org settings" },
  ],
  compliance_manager: [
    { label: "Licenses", href: "/licensing", icon: FileText, description: "Review state licenses" },
    { label: "Certifications", href: "/certifications", icon: Award, description: "Check cert status" },
    { label: "Audit Log", href: "/compliance", icon: ShieldCheck, description: "Export audit trail" },
    { label: "Documents", href: "/documents", icon: FolderOpen, description: "Compliance docs" },
  ],
  agent_support: [
    { label: "View Agents", href: "/agents", icon: Users, description: "Browse agent roster" },
    { label: "Create Task", href: "/tasks", icon: PlusCircle, description: "Create a task" },
    { label: "CRM", href: "/crm", icon: PhoneCall, description: "Contact management" },
    { label: "Documents", href: "/documents", icon: FolderOpen, description: "View documents" },
  ],
  viewer: [
    { label: "Agents", href: "/agents", icon: Users, description: "View agent roster" },
    { label: "Licenses", href: "/licensing", icon: FileText, description: "View licenses" },
    { label: "Tasks", href: "/tasks", icon: CheckSquare, description: "View task list" },
    { label: "Documents", href: "/documents", icon: FolderOpen, description: "View documents" },
  ],
  agent: [
    { label: "My Tasks", href: "/tasks", icon: CheckSquare, description: "View assigned tasks" },
    { label: "Licenses", href: "/licensing", icon: FileText, description: "My state licenses" },
    { label: "Certifications", href: "/certifications", icon: Award, description: "My certifications" },
    { label: "Training", href: "/documents", icon: BookOpen, description: "Training materials" },
  ],
};

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: activity = [], isLoading: activityLoading } =
    useGetDashboardActivity({ limit: 15 });
  const { data: me } = useGetMe();
  const userRole = (me?.role ?? null) as Role | null;
  // Fall back to viewer actions while role is loading or unset so the section is always visible.
  const quickActions = QUICK_ACTIONS[userRole ?? "viewer"] ?? QUICK_ACTIONS.viewer;

  const agentPieData = stats
    ? [
        { name: "Active", value: stats.agentsByStatus.active, color: "#22c55e" },
        { name: "Onboarding", value: stats.agentsByStatus.onboarding, color: "#f59e0b" },
        { name: "Suspended", value: stats.agentsByStatus.suspended, color: "#ef4444" },
        { name: "Offboarding", value: stats.agentsByStatus.offboarding, color: "#f97316" },
        { name: "Offboarded", value: stats.agentsByStatus.offboarded, color: "#94a3b8" },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Agency overview — {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      {/* Role-based quick actions */}
      {quickActions.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <Link key={action.href + action.label} href={action.href}>
                  <div className="flex flex-col items-start gap-2 p-4 rounded-xl border border-border bg-card hover:bg-accent hover:border-accent-foreground/20 transition-colors cursor-pointer group">
                    <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/15 transition-colors">
                      <Icon className="h-4.5 w-4.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{action.label}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{action.description}</p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* License expiry alerts */}
      {stats && stats.licensesExpiringIn30Days > 0 && (
        <Alert className="border-amber-200 bg-amber-50">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            <strong>{stats.licensesExpiringIn30Days}</strong> license
            {stats.licensesExpiringIn30Days !== 1 ? "s" : ""} expiring within 30 days.{" "}
            <a href="/licensing" className="underline font-medium">
              Review now
            </a>
          </AlertDescription>
        </Alert>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          title="Total Agents"
          value={stats?.totalAgents ?? 0}
          subtitle={`${stats?.agentsByStatus.active ?? 0} active`}
          icon={Users}
          loading={statsLoading}
        />
        <StatCard
          title="Licenses Expiring (90d)"
          value={stats?.licensesExpiringIn90Days ?? 0}
          subtitle={`${stats?.licensesExpiringIn30Days ?? 0} within 30 days`}
          icon={FileText}
          loading={statsLoading}
          variant={
            (stats?.licensesExpiringIn30Days ?? 0) > 0 ? "warning" : "default"
          }
        />
        <StatCard
          title="Open Tasks"
          value={stats?.openTasksCount ?? 0}
          subtitle={`${stats?.overdueTasks ?? 0} overdue`}
          icon={CheckSquare}
          loading={statsLoading}
          variant={(stats?.overdueTasks ?? 0) > 0 ? "danger" : "default"}
        />
        <StatCard
          title="Open Leads"
          value={stats?.openLeadsCount ?? 0}
          subtitle={`${stats?.totalContacts ?? 0} total contacts`}
          icon={PhoneCall}
          loading={statsLoading}
        />
      </div>

      {/* Second row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Agent status breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Agent Status Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : stats ? (
              <div className="flex gap-4 items-center">
                <div className="shrink-0">
                  <PieChart width={120} height={120}>
                    <Pie
                      data={agentPieData}
                      cx={55}
                      cy={55}
                      innerRadius={35}
                      outerRadius={55}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {agentPieData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => [value, ""]}
                      contentStyle={{ fontSize: 12 }}
                    />
                  </PieChart>
                </div>
                <div className="space-y-2 min-w-0 flex-1">
                  {Object.entries(stats.agentsByStatus).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between gap-2">
                      <Badge
                        variant="secondary"
                        className={`text-[11px] shrink-0 ${STATUS_COLORS[status] ?? ""}`}
                      >
                        {status}
                      </Badge>
                      <span className="text-sm font-semibold">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* AHIP completion rate */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Award className="h-4 w-4 text-primary" />
              AHIP Completion ({stats?.ahipPlanYear ?? sellingPlanYear()})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {statsLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                <div className="flex items-end gap-2 mb-3">
                  <span className="text-3xl font-bold text-foreground">
                    {stats?.ahipCompletionRateCurrent ?? 0}%
                  </span>
                  <span className="text-sm text-muted-foreground mb-1">complete</span>
                </div>
                <Progress
                  value={stats?.ahipCompletionRateCurrent ?? 0}
                  className="h-2"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  {stats?.ahipCompletionRateCurrent === 100
                    ? "All agents certified for this year"
                    : `${100 - (stats?.ahipCompletionRateCurrent ?? 0)}% remaining`}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Licensing alerts */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              License Expiry Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (stats?.agentsWithExpiringLicenses ?? []).length === 0 ? (
              <div className="py-6 text-center">
                <TrendingUp className="h-8 w-8 mx-auto mb-2 text-green-500 opacity-60" />
                <p className="text-sm text-muted-foreground">No expiring licenses in the next 90 days</p>
              </div>
            ) : (
              <div className="space-y-2">
                {(stats?.agentsWithExpiringLicenses ?? []).slice(0, 4).map((alert, i) => (
                  <div
                    key={i}
                    className={`flex items-center justify-between gap-2 py-1.5 px-2.5 rounded-md ${
                      alert.daysUntilExpiry <= 30
                        ? "bg-red-50"
                        : alert.daysUntilExpiry <= 60
                        ? "bg-amber-50"
                        : "bg-slate-50"
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{alert.agentName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {alert.stateCode} · {alert.licenseType}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={`text-[11px] shrink-0 ${
                        alert.daysUntilExpiry <= 30
                          ? "bg-red-100 text-red-800"
                          : alert.daysUntilExpiry <= 60
                          ? "bg-amber-100 text-amber-800"
                          : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {alert.daysUntilExpiry}d
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity feed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activityLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : activity.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>No recent activity</p>
            </div>
          ) : (
            <div className="space-y-1">
              {activity.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-muted/40 transition-colors"
                >
                  <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Activity className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{item.title}</p>
                    {item.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {formatDistanceToNow(new Date(item.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
