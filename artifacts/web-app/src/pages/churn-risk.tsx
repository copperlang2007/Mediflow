import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import { TrendingDown, AlertTriangle, ShieldAlert, Activity, CalendarClock, Target, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader, MiniStat, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell } from "@/components/ops";

type Band = "high" | "medium" | "low";

interface ScoredMember {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  currentPlanType: string | null;
  lastActivityAt: string | null;
  score: number;
  band: Band;
  reasons: string[];
}

interface ChurnSummary {
  totalMembers: number;
  high: number;
  medium: number;
  low: number;
  averageScore: number;
}

const BAND_CONFIG: Record<Band, { label: string; tone: StatusTone; bar: string; text: string }> = {
  high: { label: "High risk", tone: "danger", bar: "bg-destructive", text: "text-destructive" },
  medium: { label: "Medium", tone: "warning", bar: "bg-warning", text: "text-amber-600 dark:text-warning" },
  low: { label: "Low", tone: "success", bar: "bg-success", text: "text-success" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Medicare election periods are fixed by CMS each year — shown so the team
// knows which window is open. No member data is involved.
const PERIODS: Array<{ code: string; name: string; dates: string; note: string; active: (d: Date) => boolean }> = [
  {
    code: "AEP",
    name: "Annual Enrollment Period",
    dates: "Oct 15 – Dec 7",
    note: "Members can switch plans — the highest-churn window",
    active: (d) => {
      const m = d.getMonth();
      const day = d.getDate();
      return (m === 9 && day >= 15) || m === 10 || (m === 11 && day <= 7);
    },
  },
  {
    code: "OEP",
    name: "MA Open Enrollment Period",
    dates: "Jan 1 – Mar 31",
    note: "One Medicare Advantage plan switch allowed",
    active: (d) => d.getMonth() <= 2,
  },
  {
    code: "SEP",
    name: "Special Enrollment Periods",
    dates: "Any time, with a qualifying event",
    note: "Moves, loss of coverage, Extra Help and more",
    active: () => false,
  },
];

export default function ChurnRiskPage() {
  const [, navigate] = useLocation();
  const [band, setBand] = useState<"all" | Band>("all");

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["churn", "summary"],
    queryFn: () => customFetch<ChurnSummary>("/api/churn/summary"),
    staleTime: 60_000,
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ["churn", "scores", band],
    queryFn: () =>
      customFetch<ScoredMember[]>(`/api/churn/scores${band !== "all" ? `?band=${band}` : ""}`),
  });

  const today = new Date();
  const toggle = (b: Band) => setBand((cur) => (cur === b ? "all" : b));

  const bandCard = (b: Band, label: string, icon: typeof ShieldAlert, tone: "danger" | "warning" | "success", hint: string) => (
    <button type="button" onClick={() => toggle(b)} aria-pressed={band === b} className="text-left">
      <MiniStat
        label={label}
        value={summary?.[b] ?? 0}
        icon={icon}
        tone={tone}
        loading={summaryLoading}
        className={cn("hover:shadow-md", band === b && "ring-2 ring-accent ring-offset-2 ring-offset-background")}
      />
      <span className="sr-only">{hint}</span>
    </button>
  );

  return (
    <PageShell>
      <PageHeader
        title="Retention & Churn Risk"
        subtitle="Current members ranked by how likely they are to leave — call the riskiest first"
      >
        <StatusPill tone="navy" className="text-sm px-3 py-1">{summary?.totalMembers ?? 0} members scored</StatusPill>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {bandCard("high", "High risk — call first", AlertTriangle, "danger", "Filter to high risk")}
        {bandCard("medium", "Medium risk", ShieldAlert, "warning", "Filter to medium risk")}
        {bandCard("low", "Low risk", Activity, "success", "Filter to low risk")}
        <MiniStat label="Average risk score (0–100)" value={summary?.averageScore ?? 0} icon={TrendingDown} loading={summaryLoading} />
      </div>

      <SectionCard
        title="Medicare election periods"
        description="When members are allowed to change plans"
        icon={CalendarClock}
        iconClassName="text-warning"
        className="border-warning/30 bg-warning/5"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PERIODS.map((p) => {
            const on = p.active(today);
            return (
              <div
                key={p.code}
                className={cn(
                  "rounded-lg border bg-card p-4",
                  on ? "border-warning/50 shadow-sm" : "border-border",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="rounded bg-navy-800 px-1.5 py-0.5 text-[11px] font-bold text-white dark:bg-secondary">{p.code}</span>
                  {on && <StatusPill tone="warning">Open now</StatusPill>}
                </div>
                <p className="mt-2 font-medium text-sm">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.dates}</p>
                <p className="mt-2 text-xs text-muted-foreground">{p.note}</p>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title={band === "all" ? "Members by risk" : `${BAND_CONFIG[band].label} members`}
        description="Scored on recent contact, open complaints, at-risk flags and first renewals — never health or race answers. Click a member to open their record."
        icon={Target}
        actions={
          band !== "all" ? (
            <Button variant="outline" size="sm" onClick={() => setBand("all")}>
              Clear filter — showing {BAND_CONFIG[band].label}
            </Button>
          ) : undefined
        }
      >
      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : (rows ?? []).length === 0 ? (
        band === "all" ? (
          <EmptyState
            icon={ShieldCheck}
            title="No members to score yet"
            description="Once clients are enrolled on a plan, each one gets a churn-risk score here based on their plan and how recently you've been in touch."
          />
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title={band === "high" ? "No high-risk members — nice" : "No members match the current filter."}
            description="Try another risk level, or clear the filter."
          />
        )
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((m) => {
            const cfg = BAND_CONFIG[m.band];
            const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || "Member";
            const initials = `${m.firstName?.[0] ?? ""}${m.lastName?.[0] ?? ""}`.toUpperCase() || "M";
            return (
              <div
                key={m.contactId}
                role="button"
                tabIndex={0}
                className="flex cursor-pointer flex-col gap-4 rounded-lg border border-border p-4 transition-colors hover:bg-muted/30 hover:border-accent/40 sm:flex-row sm:items-center"
                onClick={() => navigate(`/crm/contacts/${m.contactId}`)}
                onKeyDown={(e) => { if (e.key === "Enter") navigate(`/crm/contacts/${m.contactId}`); }}
              >
                <div className="flex items-center gap-3 sm:w-64 shrink-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-800 text-xs font-semibold dark:bg-secondary dark:text-secondary-foreground">
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{name}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.currentPlanType ? `${m.currentPlanType} · ` : ""}Last contact: {fmtDate(m.lastActivityAt)}
                    </p>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Why they might leave</p>
                  {m.reasons.length > 0 ? (
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      {m.reasons.map((r, i) => (
                        <span key={i} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{r}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1">No warning signs</p>
                  )}
                </div>
                <div className="shrink-0 sm:w-36 sm:text-right">
                  <div className="flex items-center gap-2 sm:justify-end">
                    <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full ${cfg.bar}`} style={{ width: `${m.score}%` }} />
                    </div>
                    <span className={cn("font-display text-lg font-bold tabular-nums", cfg.text)}>{m.score}</span>
                  </div>
                  <StatusPill tone={cfg.tone} className="mt-1">{cfg.label}</StatusPill>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </SectionCard>
    </PageShell>
  );
}
