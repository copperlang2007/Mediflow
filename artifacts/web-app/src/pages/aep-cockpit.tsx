import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CalendarClock,
  Users,
  ClipboardCheck,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CalendarDays,
} from "lucide-react";

interface AepCockpit {
  seasonYear: number;
  generatedAt: string;
  keyDates: {
    reviewDeadline: string;
    newPlanDetails: string;
    aepEnrollmentStart: string;
    aepEnrollmentEnd: string;
    renewalDate: string;
  };
  members: {
    total: number;
    byPlanType: Record<string, number>;
    withReviewTask: number;
    withoutReviewTask: number;
    coverageRate: number;
  };
  reviewTasks: {
    total: number;
    active: number;
    completed: number;
    cancelled: number;
    overdue: number;
    completionRate: number;
  };
  byAgent: Array<{
    agentId: string | null;
    agentName: string;
    total: number;
    completed: number;
    open: number;
    overdue: number;
  }>;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const TIMELINE: Array<{ key: keyof AepCockpit["keyDates"]; label: string; note: string }> = [
  { key: "reviewDeadline", label: "Set review by", note: "Before new plan details drop" },
  { key: "newPlanDetails", label: "Plan details", note: "Next year's plans become available" },
  { key: "aepEnrollmentStart", label: "AEP opens", note: "Enrollment window starts" },
  { key: "aepEnrollmentEnd", label: "AEP closes", note: "Last day to enroll" },
  { key: "renewalDate", label: "Renewal", note: "Plans renew January 1" },
];

function KpiCard({
  label,
  value,
  icon: Icon,
  className,
  sub,
}: {
  label: string;
  value: number | string;
  icon: typeof Users;
  className: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <Icon className={`h-4 w-4 ${className}`} />
      </div>
      <div className={`text-2xl font-bold mt-1 ${className}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export default function AepCockpitPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["aep-cockpit"],
    queryFn: () => customFetch<AepCockpit>("/api/aep-cockpit"),
    staleTime: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 space-y-5 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const planEntries = Object.entries(data.members.byPlanType);

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">AEP Command Center</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data.seasonYear} season readiness — members renew Jan 1, {data.seasonYear + 1}.
            Reviews should be set before Oct 1.
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          Season {data.seasonYear}
        </Badge>
      </div>

      {/* Coverage + completion hero */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-blue-600" />
              Review coverage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between">
              <div className="text-3xl font-bold">{pct(data.members.coverageRate)}</div>
              <div className="text-sm text-muted-foreground">
                {data.members.withReviewTask} of {data.members.total} members have a review task
              </div>
            </div>
            <Progress value={data.members.coverageRate * 100} className="mt-3" />
            {data.members.withoutReviewTask > 0 && (
              <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {data.members.withoutReviewTask} member
                {data.members.withoutReviewTask === 1 ? "" : "s"} still need a review task
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Review completion
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between">
              <div className="text-3xl font-bold">{pct(data.reviewTasks.completionRate)}</div>
              <div className="text-sm text-muted-foreground">
                {data.reviewTasks.completed} of {data.reviewTasks.total} review tasks done
              </div>
            </div>
            <Progress value={data.reviewTasks.completionRate * 100} className="mt-3" />
            {data.reviewTasks.overdue > 0 && (
              <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {data.reviewTasks.overdue} overdue
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Members"
          value={data.members.total}
          icon={Users}
          className="text-slate-700"
          sub={planEntries.map(([k, v]) => `${k} ${v}`).join(" · ") || undefined}
        />
        <KpiCard label="Active reviews" value={data.reviewTasks.active} icon={CircleDashed} className="text-blue-600" />
        <KpiCard label="Completed" value={data.reviewTasks.completed} icon={CheckCircle2} className="text-green-600" />
        <KpiCard label="Overdue" value={data.reviewTasks.overdue} icon={AlertTriangle} className="text-red-600" />
      </div>

      {/* Key dates timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Season key dates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {TIMELINE.map((t) => (
              <div key={t.key} className="rounded-lg border p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <CalendarClock className="h-3.5 w-3.5" />
                  {t.label}
                </div>
                <div className="text-sm font-bold mt-1">{fmtDate(data.keyDates[t.key])}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{t.note}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Per-agent breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Review progress by agent</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No review tasks yet for this season.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Overdue</TableHead>
                  <TableHead className="w-40">Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byAgent.map((a) => {
                  const rate = a.total > 0 ? a.completed / a.total : 0;
                  return (
                    <TableRow key={a.agentId ?? "unassigned"}>
                      <TableCell className="font-medium">{a.agentName}</TableCell>
                      <TableCell className="text-right">{a.total}</TableCell>
                      <TableCell className="text-right text-green-700">{a.completed}</TableCell>
                      <TableCell className="text-right">{a.open}</TableCell>
                      <TableCell className="text-right">
                        {a.overdue > 0 ? (
                          <span className="text-red-600 font-medium">{a.overdue}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={rate * 100} className="h-2" />
                          <span className="text-xs text-muted-foreground w-9 text-right">{pct(rate)}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
