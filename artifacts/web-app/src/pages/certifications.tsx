import { useState } from "react";
import { useGetAhipDashboard, useGetCertificationMatrix, useGetRenewals } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Award, ShieldCheck, CheckCircle, Clock, AlertTriangle, Users, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid } from "@/components/ops";
import { sellingPlanYear } from "@/lib/planYear";

const CERT_TONES: Record<string, StatusTone> = {
  passed: "success",
  failed: "danger",
  in_progress: "info",
  not_started: "neutral",
  waived: "navy",
};

const CERT_CELL_STYLES: Record<string, string> = {
  passed: "bg-success/12 text-success",
  failed: "bg-destructive/10 text-destructive",
  in_progress: "bg-accent/10 text-accent",
  not_started: "bg-muted text-muted-foreground",
  waived: "bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground",
};

const humanCert = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export default function CertificationsPage() {
  const currentYear = sellingPlanYear();
  const [year, setYear] = useState(String(currentYear));
  const [view, setView] = useState<"ahip" | "carriers">("ahip");
  const [, navigate] = useLocation();

  const { data: ahip, isLoading: ahipLoading } = useGetAhipDashboard({ year: parseInt(year, 10) });
  const { data: matrix, isLoading: matrixLoading } = useGetCertificationMatrix({ year: parseInt(year, 10) });
  const { data: certRenewals } = useGetRenewals({ days: 90 });
  const expiringCerts = certRenewals?.renewals.filter((r) => r.type === "certification") ?? [];

  const years = [currentYear + 1, currentYear, currentYear - 1].map(String);
  // Shared AHIP definition (API lib/agents/ahipCoverage.ts): agents who need
  // AHIP are active + onboarding; complete = passed or waived. Renewals and
  // the dashboard use the same numbers.
  const needAhip = ahip?.agentsRequiringAhip ?? ahip?.totalActiveAgents ?? 0;
  const notDone = needAhip - (ahip?.passedCount ?? 0);

  return (
    <PageShell>
      <PageHeader
        title="Certifications"
        subtitle="AHIP and carrier certifications agents need before they can sell each year"
      >
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={y}>Plan year {y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      <KpiGrid>
        <KpiCard
          label="Agents who need AHIP"
          value={ahip?.agentsRequiringAhip ?? ahip?.totalActiveAgents ?? 0}
          icon={Users}
          color="navy"
          loading={ahipLoading}
          hint={`Active and onboarding agents, plan year ${year}`}
        />
        <KpiCard
          label={`AHIP complete ${year}`}
          value={ahip?.passedCount ?? 0}
          icon={ShieldCheck}
          color="green"
          loading={ahipLoading}
          hint="Passed or waived"
        />
        <KpiCard
          label="Completion rate"
          value={`${Math.round(ahip?.completionRate ?? 0)}%`}
          icon={CheckCircle}
          color="blue"
          loading={ahipLoading}
          hint={<Progress value={ahip?.completionRate ?? 0} className="h-1.5 mt-1 bg-white/20 [&>div]:bg-white" />}
        />
        <KpiCard
          label="Not yet completed"
          value={notDone}
          icon={AlertTriangle}
          color="orange"
          loading={ahipLoading}
          hint={notDone === 0 && needAhip > 0 ? "Everyone's done — nice" : "Nudge these agents"}
        />
      </KpiGrid>

      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
        <TabsList className="h-10">
          <TabsTrigger value="ahip">AHIP</TabsTrigger>
          <TabsTrigger value="carriers">Carrier certifications</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "ahip" && (
        <SectionCard title={`AHIP status — ${year}`} description="Click an agent to open their profile" icon={ShieldCheck}>
          {ahipLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (ahip?.records ?? []).length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={`No AHIP records for ${year} yet`}
              description="When agents complete AHIP, record it on their profile and they'll show up here with their score."
            />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {(ahip?.records ?? []).sort((a, b) => {
                const order = { passed: 0, in_progress: 1, not_started: 2, failed: 3, waived: 4 };
                return (order[a.status as keyof typeof order] ?? 5) - (order[b.status as keyof typeof order] ?? 5);
              }).map((rec) => (
                <div
                  key={rec.agentId}
                  className="group flex items-center gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                  onClick={() => navigate(`/agents/${rec.agentId}`)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-800 text-xs font-semibold dark:bg-secondary dark:text-secondary-foreground">
                    {`${rec.firstName?.[0] ?? ""}${rec.lastName?.[0] ?? ""}`.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{rec.firstName} {rec.lastName}</p>
                    <p className="text-xs text-muted-foreground">
                      {rec.completedDate
                        ? `Completed ${format(new Date(rec.completedDate), "MMM d, yyyy")}`
                        : "Not completed yet"}
                    </p>
                  </div>
                  {rec.score != null && (
                    <span className="text-sm tabular-nums font-medium text-muted-foreground">Score {rec.score}%</span>
                  )}
                  <StatusPill tone={CERT_TONES[rec.status] ?? "neutral"}>{humanCert(rec.status)}</StatusPill>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-accent" />
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {view === "carriers" && (
        <SectionCard
          title={`Carrier certifications — ${year}`}
          description="Which agents are certified to sell each carrier's plans"
          icon={Award}
        >
          {matrixLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (matrix?.agents ?? []).length === 0 ? (
            <EmptyState
              icon={Award}
              title="Nothing to show yet"
              description="Add active agents and carriers, and this grid will show who is certified with whom."
            />
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground px-4 py-3 sticky left-0 bg-muted z-10 min-w-[160px]">
                      Agent
                    </th>
                    {(matrix?.carriers ?? []).map((carrier) => (
                      <th key={carrier.id} className="text-center text-xs font-semibold text-muted-foreground px-3 py-3 min-w-[100px]">
                        {carrier.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(matrix?.agents ?? []).map((agent) => (
                    <tr
                      key={agent.id}
                      className="hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => navigate(`/agents/${agent.id}`)}
                    >
                      <td className="px-4 py-3 sticky left-0 bg-card font-medium">
                        {agent.firstName} {agent.lastName}
                      </td>
                      {(matrix?.carriers ?? []).map((carrier) => {
                        const status = matrix?.certMap?.[agent.id]?.[carrier.id] ?? "not_started";
                        return (
                          <td key={carrier.id} className="px-3 py-3 text-center">
                            <span className={cn(
                              "inline-block text-[11px] font-medium px-2 py-0.5 rounded-full",
                              CERT_CELL_STYLES[status] ?? "bg-muted text-muted-foreground",
                            )}>
                              {humanCert(status)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard
        title="Expiring in the next 90 days"
        description="Certifications that need renewing soon"
        icon={Clock}
        iconClassName="text-warning"
      >
        {expiringCerts.length === 0 ? (
          <EmptyState
            compact
            icon={CheckCircle}
            title="Nothing expiring soon — nice"
            description="We'll list any certification here once it's within 90 days of expiring."
          />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {expiringCerts.slice(0, 8).map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                onClick={() => navigate(`/agents/${r.agentId}`)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{r.agentName}</p>
                  <p className="text-xs text-muted-foreground">{r.detail}</p>
                </div>
                <p className="text-xs text-muted-foreground">{format(new Date(r.expiryDate), "MMM d, yyyy")}</p>
                <StatusPill tone={r.urgency === "critical" ? "danger" : r.urgency === "warning" ? "warning" : "info"}>
                  {r.daysUntilExpiry} days left
                </StatusPill>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </PageShell>
  );
}
