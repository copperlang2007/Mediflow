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
import { cn } from "@/lib/utils";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame } from "@/components/ops";

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

export default function AepCockpitPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["aep-cockpit"],
    queryFn: () => customFetch<AepCockpit>("/api/aep-cockpit"),
    staleTime: 60_000,
  });

  if (isError && !data) {
    return (
      <PageShell>
        <PageHeader title="AEP Center" subtitle="Annual Enrollment Period readiness" />
        <SectionCard>
          <EmptyState
            icon={AlertTriangle}
            title="We couldn't load the AEP numbers"
            description="Please try again in a moment."
            action={{ label: "Try again", onClick: () => void refetch() }}
          />
        </SectionCard>
      </PageShell>
    );
  }

  if (isLoading || !data) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </PageShell>
    );
  }

  const planEntries = Object.entries(data.members.byPlanType);
  const now = Date.now();
  const nextKey = TIMELINE.find((t) => new Date(data.keyDates[t.key]).getTime() >= now)?.key;

  return (
    <PageShell>
      <PageHeader
        title="AEP Center"
        subtitle={`Get every member reviewed before the ${data.seasonYear} Annual Enrollment Period — plans renew Jan 1, ${data.seasonYear + 1}. Aim to set reviews before Oct 1.`}
      >
        <StatusPill tone="navy" className="text-sm px-3 py-1">Season {data.seasonYear}</StatusPill>
      </PageHeader>

      <KpiGrid>
        <KpiCard
          label="Members to review"
          value={data.members.total}
          icon={Users}
          color="navy"
          hint={planEntries.map(([k, v]) => `${k} ${v}`).join(" · ") || "No members on a plan yet"}
        />
        <KpiCard
          label="Reviews in progress"
          value={data.reviewTasks.active}
          icon={CircleDashed}
          color="blue"
          hint={`${data.reviewTasks.total} review tasks in total`}
        />
        <KpiCard
          label="Reviews completed"
          value={data.reviewTasks.completed}
          icon={CheckCircle2}
          color="green"
          hint={`${pct(data.reviewTasks.completionRate)} done`}
        />
        <KpiCard
          label="Overdue"
          value={data.reviewTasks.overdue}
          icon={AlertTriangle}
          color="orange"
          hint={data.reviewTasks.overdue === 0 ? "Nothing overdue — nice" : "Past their due date"}
        />
      </KpiGrid>

      {/* Coverage + completion */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <SectionCard title="Review coverage" description="Members who have a review task set up" icon={ClipboardCheck}>
          <div className="flex items-end justify-between gap-3">
            <div className="font-display text-4xl font-bold">{pct(data.members.coverageRate)}</div>
            <div className="text-sm text-muted-foreground text-right">
              {data.members.withReviewTask} of {data.members.total} members have a review task
            </div>
          </div>
          <Progress value={data.members.coverageRate * 100} className="mt-3 h-2.5" />
          {data.members.withoutReviewTask > 0 ? (
            <p className="text-xs text-amber-700 dark:text-warning mt-3 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {data.members.withoutReviewTask} member
              {data.members.withoutReviewTask === 1 ? "" : "s"} still need a review task
            </p>
          ) : data.members.total > 0 ? (
            <p className="text-xs text-success mt-3 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Every member has a review task
            </p>
          ) : null}
        </SectionCard>
        <SectionCard title="Review completion" description="Review tasks marked done" icon={CheckCircle2} iconClassName="text-success">
          <div className="flex items-end justify-between gap-3">
            <div className="font-display text-4xl font-bold">{pct(data.reviewTasks.completionRate)}</div>
            <div className="text-sm text-muted-foreground text-right">
              {data.reviewTasks.completed} of {data.reviewTasks.total} review tasks done
            </div>
          </div>
          <Progress value={data.reviewTasks.completionRate * 100} className="mt-3 h-2.5" />
          {data.reviewTasks.overdue > 0 && (
            <p className="text-xs text-destructive mt-3 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {data.reviewTasks.overdue} overdue
            </p>
          )}
        </SectionCard>
      </div>

      {/* Key dates timeline */}
      <SectionCard title="Season key dates" description="What happens when this season" icon={CalendarDays}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {TIMELINE.map((t) => {
            const when = new Date(data.keyDates[t.key]).getTime();
            const past = when < now;
            const isNext = t.key === nextKey;
            return (
              <div
                key={t.key}
                className={cn(
                  "rounded-lg border p-3",
                  isNext ? "border-accent/50 bg-accent/5" : "border-border",
                  past && "opacity-60",
                )}
              >
                <div className="flex items-center justify-between gap-1.5 text-xs font-semibold text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {t.label}
                  </span>
                  {isNext && <StatusPill tone="info">Next</StatusPill>}
                  {past && <StatusPill tone="neutral">Done</StatusPill>}
                </div>
                <div className="font-display text-base font-bold mt-1.5">{fmtDate(data.keyDates[t.key])}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{t.note}</div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      {/* Per-agent breakdown */}
      <SectionCard title="Review progress by agent" description="Each agent's share of this season's reviews" icon={Users}>
          {data.byAgent.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No review tasks yet for this season."
              description="When review tasks are created for members, each agent's progress shows up here."
            />
          ) : (
            <TableFrame>
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
                      <TableCell className="text-right tabular-nums">{a.total}</TableCell>
                      <TableCell className="text-right tabular-nums text-success font-medium">{a.completed}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.open}</TableCell>
                      <TableCell className="text-right">
                        {a.overdue > 0 ? (
                          <StatusPill tone="danger">{a.overdue}</StatusPill>
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
            </TableFrame>
          )}
      </SectionCard>
    </PageShell>
  );
}
