import { useState } from "react";
import {
  useGetRenewals,
  useSnoozeRenewal,
  useResolveRenewal,
  getGetRenewalsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCcw, AlertTriangle, Clock, Info, CheckCircle2, BellOff } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid } from "@/components/ops";
import { FileText, Award, ShieldCheck, Users, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const URGENCY_CONFIG = {
  critical: { label: "Critical", color: "bg-red-100 text-red-800 border-red-200", icon: AlertTriangle, iconColor: "text-red-500" },
  warning: { label: "Warning", color: "bg-amber-100 text-amber-800 border-amber-200", icon: Clock, iconColor: "text-amber-500" },
  notice: { label: "Notice", color: "bg-blue-100 text-blue-800 border-blue-200", icon: Info, iconColor: "text-blue-500" },
};

type UrgencyFilter = "all" | "critical" | "warning" | "notice";
type TypeFilter = "all" | "license" | "certification";

// ─── Compliance alerts dashboard card ─────────────────────────────────────────
type ComplianceAlerts = {
  generatedAt: string;
  currentCertYear: number;
  daysUntilAhipDeadline: number;
  licenses: { critical: number; warning: number; notice: number; expired?: number };
  certifications: { critical: number; warning: number; notice: number };
  ahip: {
    passed: number;
    in_progress: number;
    not_started: number;
    missing: number;
    failed: number;
    totalActiveAgents: number;
    completionRate: number;
  };
  topAgents: Array<{
    agentId: string;
    agentName: string;
    licensesExpiring: number;
    licensesExpired?: number;
    certsExpiring: number;
    ahipStatus: "passed" | "in_progress" | "not_started" | "missing" | "failed";
    alertCount: number;
  }>;
  agentsWithAlerts: number;
};

function ComplianceAlertsCard({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const { data, isLoading } = useQuery<ComplianceAlerts>({
    queryKey: ["/api/compliance-alerts"],
    queryFn: () => customFetch<ComplianceAlerts>("/api/compliance-alerts"),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
    );
  }
  if (!data) return null;

  const totalLicenseAlerts =
    data.licenses.critical + data.licenses.warning + data.licenses.notice;
  const totalCertAlerts =
    data.certifications.critical + data.certifications.warning + data.certifications.notice;

  return (
    <div className="space-y-6">
        <KpiGrid>
          <KpiCard
            label="Licenses expiring (90 days)"
            value={totalLicenseAlerts}
            icon={FileText}
            color="navy"
            hint={
              (data.licenses.expired ?? 0) > 0
                ? `${data.licenses.expired} already expired${totalLicenseAlerts > 0 ? ` · ${data.licenses.critical} within 30 days` : ""}`
                : totalLicenseAlerts === 0
                  ? "None — nice"
                  : `${data.licenses.critical} within 30 days`
            }
          />
          <KpiCard
            label="Certifications expiring (90 days)"
            value={totalCertAlerts}
            icon={Award}
            color="blue"
            hint={totalCertAlerts === 0 ? "None — nice" : `${data.certifications.critical} within 30 days`}
          />
          <KpiCard
            label={`AHIP ${data.currentCertYear} complete`}
            value={`${data.ahip.completionRate}%`}
            icon={ShieldCheck}
            color="green"
            hint={`${data.ahip.passed} of ${data.ahip.totalActiveAgents} active + onboarding agents · ${
              data.daysUntilAhipDeadline >= 0 ? `${data.daysUntilAhipDeadline} days to Oct 1` : "deadline passed"
            }`}
          />
          <KpiCard
            label="Agents needing attention"
            value={data.agentsWithAlerts}
            icon={Users}
            color="orange"
            hint={data.agentsWithAlerts === 0 ? "Everyone's in good standing" : "See the list below"}
          />
        </KpiGrid>
        {data.topAgents.length > 0 && (
          <SectionCard
            title="Agents needing attention"
            description={`Top ${data.topAgents.length} of ${data.agentsWithAlerts} agent${data.agentsWithAlerts !== 1 ? "s" : ""}, most alerts first`}
            icon={Users}
          >
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {data.topAgents.map((a) => (
                <button
                  key={a.agentId}
                  onClick={() => onNavigate(`/agents/${a.agentId}`)}
                  className="group w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="flex-1 text-sm font-medium truncate">{a.agentName}</span>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    {(a.licensesExpired ?? 0) > 0 && (
                      <StatusPill tone="danger">
                        {a.licensesExpired} license{a.licensesExpired !== 1 ? "s" : ""} expired
                      </StatusPill>
                    )}
                    {a.licensesExpiring > 0 && (
                      <StatusPill tone="warning">
                        {a.licensesExpiring} license{a.licensesExpiring !== 1 ? "s" : ""}
                      </StatusPill>
                    )}
                    {a.certsExpiring > 0 && (
                      <StatusPill tone="warning">
                        {a.certsExpiring} cert{a.certsExpiring !== 1 ? "s" : ""}
                      </StatusPill>
                    )}
                    {a.ahipStatus !== "passed" && (
                      <StatusPill tone={a.ahipStatus === "missing" || a.ahipStatus === "failed" ? "danger" : "warning"}>
                        AHIP {a.ahipStatus.replace("_", " ")}
                      </StatusPill>
                    )}
                  </div>
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-navy-100 px-1.5 text-xs font-bold tabular-nums text-navy-800 dark:bg-secondary dark:text-secondary-foreground">
                    {a.alertCount}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-accent" />
                </button>
              ))}
            </div>
          </SectionCard>
        )}
    </div>
  );
}

export default function RenewalsPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [days, setDays] = useState(90);
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const { data, isLoading, refetch } = useGetRenewals({ days });
  const { mutateAsync: snooze, isPending: snoozing } = useSnoozeRenewal();
  const { mutateAsync: resolve, isPending: resolving } = useResolveRenewal();

  const renewals = (data?.renewals ?? []).filter((r) => {
    if (urgencyFilter !== "all" && r.urgency !== urgencyFilter) return false;
    if (typeFilter !== "all" && r.type !== typeFilter) return false;
    return true;
  });

  const counts = {
    critical: (data?.renewals ?? []).filter((r) => r.urgency === "critical").length,
    warning: (data?.renewals ?? []).filter((r) => r.urgency === "warning").length,
    notice: (data?.renewals ?? []).filter((r) => r.urgency === "notice").length,
  };

  const handleSnooze = async (resourceType: string, id: string, agentName: string) => {
    try {
      await snooze({ resourceType: resourceType as "license" | "certification", id, data: { days: 30 } });
      toast.success(`Snoozed ${agentName}'s renewal for 30 days`);
      void qc.invalidateQueries({ queryKey: getGetRenewalsQueryKey() });
    } catch {
      toast.error("Failed to snooze renewal");
    }
  };

  const handleResolve = async (resourceType: string, id: string, agentName: string) => {
    try {
      await resolve({ resourceType: resourceType as "license" | "certification", id });
      toast.success(`Marked ${agentName}'s renewal as resolved`);
      void qc.invalidateQueries({ queryKey: getGetRenewalsQueryKey() });
    } catch {
      toast.error("Failed to resolve renewal");
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Renewals"
        subtitle="Licenses and certifications that are about to expire — snooze or mark them done"
      >
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCcw className="h-4 w-4 mr-1.5" />
          Refresh
        </Button>
      </PageHeader>

      <ComplianceAlertsCard onNavigate={navigate} />

      {/* Urgency summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(["critical", "warning", "notice"] as const).map((urgency) => {
          const cfg = URGENCY_CONFIG[urgency];
          const IconComp = cfg.icon;
          return (
            <button
              key={urgency}
              onClick={() => setUrgencyFilter(urgencyFilter === urgency ? "all" : urgency)}
              aria-pressed={urgencyFilter === urgency}
              className={cn(
                "rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:shadow-md",
                urgencyFilter === urgency && "ring-2 ring-accent ring-offset-2 ring-offset-background",
              )}
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                    urgency === "critical" ? "bg-destructive/10 text-destructive" : urgency === "warning" ? "bg-warning/15 text-warning" : "bg-accent/10 text-accent",
                  )}
                >
                  <IconComp className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {urgency === "critical" ? "Due within 30 days" : urgency === "warning" ? "Due in 31–60 days" : "Due in 61–90 days"}
                  </p>
                  <p className="font-display text-xl font-bold leading-tight">{counts[urgency]}</p>
                </div>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {urgencyFilter === urgency ? "Filtering" : "Click to filter"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <SectionCard
        title={`${renewals.length} renewal${renewals.length !== 1 ? "s" : ""}${urgencyFilter !== "all" ? ` · ${URGENCY_CONFIG[urgencyFilter].label.toLowerCase()}` : ""}`}
        description="Snooze hides an item for 30 days; Resolve marks it renewed"
      >
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="license">Licenses</SelectItem>
            <SelectItem value="certification">Certifications</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">Next 30 days</SelectItem>
            <SelectItem value="60">Next 60 days</SelectItem>
            <SelectItem value="90">Next 90 days</SelectItem>
            <SelectItem value="180">Next 180 days</SelectItem>
          </SelectContent>
        </Select>
        {urgencyFilter !== "all" && (
          <Button variant="ghost" size="sm" onClick={() => setUrgencyFilter("all")}>
            Clear filter
          </Button>
        )}
      </div>

        <div className="rounded-lg border border-border overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : renewals.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={urgencyFilter !== "all" || typeFilter !== "all" ? "Nothing matches these filters" : "No renewals due — nice"}
              description={
                urgencyFilter !== "all" || typeFilter !== "all"
                  ? "Try adjusting your filters"
                  : `No licenses or certifications expire in the next ${days} days.`
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-5 py-3 border-b border-border bg-muted/50">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Item</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-20 text-center">Type</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24 text-center">Expires</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-20 text-center">Urgency</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-36 text-right">Actions</span>
              </div>
              <div className="divide-y divide-border">
                {renewals.map((item) => {
                  const cfg = URGENCY_CONFIG[item.urgency as keyof typeof URGENCY_CONFIG];
                  const IconComp = cfg?.icon ?? Info;
                  return (
                    <div
                      key={`${item.type}-${item.id}`}
                      className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors"
                    >
                      <div className="min-w-0">
                        <button
                          className="font-medium text-sm text-foreground hover:underline text-left"
                          onClick={() => navigate(`/agents/${item.agentId}`)}
                        >
                          {item.agentName}
                        </button>
                        <p className="text-xs text-muted-foreground truncate">{item.detail}</p>
                      </div>
                      <div className="w-20 flex justify-center">
                        <StatusPill tone="navy">
                          {item.type === "license" ? "License" : "Cert"}
                        </StatusPill>
                      </div>
                      <div className="w-24 text-center">
                        <div className="text-sm font-semibold tabular-nums">
                          {item.daysUntilExpiry}d
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.expiryDate ? new Date(item.expiryDate).toLocaleDateString() : "—"}
                        </div>
                      </div>
                      <div className="w-20 flex justify-center">
                        <StatusPill
                          tone={item.urgency === "critical" ? "danger" : item.urgency === "warning" ? "warning" : "info"}
                          className="gap-1"
                        >
                          <IconComp className="h-3 w-3" />
                          {cfg?.label ?? item.urgency}
                        </StatusPill>
                      </div>
                      <div className="w-36 flex items-center justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={snoozing || resolving}
                          onClick={() => handleSnooze(item.type ?? "license", item.id, item.agentName ?? "")}
                          title="Snooze for 30 days"
                        >
                          <BellOff className="h-3.5 w-3.5 mr-1" />
                          Snooze
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs text-success border-success/30 hover:bg-success/10"
                          disabled={snoozing || resolving}
                          onClick={() => handleResolve(item.type ?? "license", item.id, item.agentName ?? "")}
                          title="Mark as resolved"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Resolve
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

      {data && data.total > 0 && (
        <p className="text-xs text-muted-foreground mt-3">
          Showing {renewals.length} of {data.total} upcoming renewals (snoozed items hidden)
        </p>
      )}
      </SectionCard>
    </PageShell>
  );
}
