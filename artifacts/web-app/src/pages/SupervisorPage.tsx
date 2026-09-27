/**
 * Supervisor — live floor + call review.
 *
 * Real data only:
 *   - the agent grid is `agent_presence` (GET /queue/presence), refreshed
 *     every 15s;
 *   - routing numbers and coverage gaps are GET /queue/routing/stats + recent;
 *   - the callback queue is GET /queue/callbacks;
 *   - "Call review" lists recent parsed post-call summaries
 *     (GET /supervisor/call-summaries).
 * Listen-in / whisper / barge, live transcripts and sentiment need browser
 * calling, which isn't built yet — they are clearly marked "coming soon".
 *
 * Supervisor tier only (super_admin / agency_admin), matching the API gate.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, ClipboardList, Ear, Headphones, MessageSquareText,
  Mic, PhoneCall, PhoneForwarded, PhoneMissed, Radio, UserCheck, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionCard, MiniStat, StatusPill, EmptyState } from "@/components/shared";
import { ComingSoonNote, NoAccess, SoonBadge } from "@/components/portal-dialer";
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import { cn } from "@/lib/utils";
import {
  useQueueCallbacks,
  useQueuePresence,
  useRecentRouting,
  useRoutingStats,
  type PresenceAgent,
} from "@/lib/queue/api";
import { SUPERVISOR_ROLES, initialsOf, useSupervisorCallSummaries } from "@/lib/portalDialer/api";
import { useProductName } from "@/lib/branding/BrandingProvider";

const STATUS_META: Record<string, { label: string; dot: string; border: string }> = {
  available: { label: "Available", dot: "bg-success", border: "border-l-success" },
  on_call: { label: "On call", dot: "bg-accent", border: "border-l-accent" },
  wrap: { label: "Wrap-up", dot: "bg-warning", border: "border-l-warning" },
  away: { label: "Away", dot: "bg-muted-foreground/60", border: "border-l-muted-foreground/40" },
  offline: { label: "Offline", dot: "bg-muted-foreground/30", border: "border-l-border" },
};

function statusMeta(a: PresenceAgent) {
  // An "available" row whose TTL lapsed is not really available.
  if (a.status === "available" && !a.availableNow) return { label: "Available (stale)", dot: "bg-warning", border: "border-l-warning" };
  return STATUS_META[a.status] ?? STATUS_META.offline;
}

function slaLabel(iso: string): { label: string; overdue: boolean } {
  const diff = new Date(iso).getTime() - Date.now();
  const m = Math.round(Math.abs(diff) / 60000);
  const t = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  return diff <= 0 ? { label: `${t} overdue`, overdue: true } : { label: `due in ${t}`, overdue: false };
}

function AgentCard({ a, routedToday, selected, onSelect }: { a: PresenceAgent; routedToday: number; selected: boolean; onSelect: () => void }) {
  const m = statusMeta(a);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-xl border border-border border-l-4 bg-card p-3.5 text-left shadow-sm transition-shadow hover:shadow-md",
        m.border,
        selected && "ring-2 ring-accent/50",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted font-semibold text-sm">
            {initialsOf(a.firstName, a.lastName)}
          </div>
          <span className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card", m.dot)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{a.firstName} {a.lastName}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
            {m.label} · {routedToday} lead{routedToday === 1 ? "" : "s"} routed today
          </p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Last seen {formatDistanceToNow(new Date(a.lastSeenAt), { addSuffix: true })}
      </p>
    </button>
  );
}

function LiveFloor() {
  const presence = useQueuePresence();
  const stats = useRoutingStats(24);
  const recent = useRecentRouting(200);
  const callbacks = useQueueCallbacks("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const agents = useMemo(() => {
    const order = ["on_call", "available", "wrap", "away", "offline"];
    return [...(presence.data?.agents ?? [])].sort(
      (x, y) => order.indexOf(x.status) - order.indexOf(y.status) || x.lastName.localeCompare(y.lastName),
    );
  }, [presence.data]);

  const routedToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const counts = new Map<string, number>();
    for (const r of recent.data?.data ?? []) {
      if (r.status === "routed" && r.agentId && new Date(r.createdAt) >= start) {
        counts.set(r.agentId, (counts.get(r.agentId) ?? 0) + 1);
      }
    }
    return counts;
  }, [recent.data]);

  const online = agents.filter((a) => a.status !== "offline").length;
  const onCall = agents.filter((a) => a.status === "on_call").length;
  const selected = agents.find((a) => a.agentId === selectedId) ?? null;
  const s = stats.data?.stats;
  const gaps = stats.data?.coverageGaps ?? [];
  const openCallbacks = callbacks.data?.data ?? [];

  return (
    <div className="space-y-6">
      <ComingSoonNote title="Listen-in, whisper, barge, live transcripts and sentiment are coming soon with browser calling." icon={Headphones}>
        Everything else on this page is live: who's on the floor, how inbound leads are being routed, and the callback queue.
      </ComingSoonNote>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MiniStat label="Agents online" value={online} icon={Users} loading={presence.isLoading} />
        <MiniStat label="Available now" value={presence.data?.availableCount ?? 0} icon={UserCheck} tone="success" loading={presence.isLoading} />
        <MiniStat label="On a call" value={onCall} icon={PhoneCall} loading={presence.isLoading} />
        <MiniStat label="Routed (24h)" value={s?.routed ?? 0} icon={PhoneForwarded} loading={stats.isLoading} />
        <MiniStat label="Missed (24h)" value={s?.noAgent ?? 0} icon={PhoneMissed} tone={(s?.noAgent ?? 0) > 0 ? "warning" : "default"} loading={stats.isLoading} />
        <MiniStat label="Open callbacks" value={openCallbacks.length} icon={ClipboardList} tone={openCallbacks.some((c) => slaLabel(c.slaDueAt).overdue) ? "danger" : "default"} loading={callbacks.isLoading} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <SectionCard
          title="Agent Floor"
          icon={Headphones}
          description="Live presence — refreshes every 15 seconds. Pick an agent for details."
          className="xl:col-span-2"
          actions={
            <div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
              {(["available", "on_call", "wrap", "away"] as const).map((k) => (
                <span key={k} className="flex items-center gap-1"><span className={cn("h-2 w-2 rounded-full", STATUS_META[k].dot)} />{STATUS_META[k].label}</span>
              ))}
            </div>
          }
        >
          {presence.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          ) : presence.isError ? (
            <p className="text-sm text-destructive">Couldn't load the agent floor.</p>
          ) : agents.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No agents have checked in yet"
              description="Agents appear here once they set their status in the app. Their availability drives inbound routing."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {agents.map((a) => (
                <AgentCard
                  key={a.agentId}
                  a={a}
                  routedToday={routedToday.get(a.agentId) ?? 0}
                  selected={a.agentId === selectedId}
                  onSelect={() => setSelectedId(a.agentId === selectedId ? null : a.agentId)}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title={selected ? `${selected.firstName} ${selected.lastName}` : "Monitor"} icon={Ear}>
          {!selected ? (
            <EmptyState
              icon={Headphones}
              title="Select an agent to monitor"
              description="See their status and today's routed leads. Listening in and coaching arrive with browser calling."
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <StatusPill tone={selected.availableNow ? "success" : selected.status === "on_call" ? "info" : "neutral"}>{statusMeta(selected).label}</StatusPill>
                <span className="text-xs text-muted-foreground">since {format(new Date(selected.lastSeenAt), "h:mm a")}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-muted/60 p-3">
                  <p className="text-xs text-muted-foreground">Routed today</p>
                  <p className="font-display text-xl font-bold">{routedToday.get(selected.agentId) ?? 0}</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-3">
                  <p className="text-xs text-muted-foreground">Presence expires</p>
                  <p className="font-display text-base font-bold">{selected.expiresAt ? format(new Date(selected.expiresAt), "h:mm a") : "—"}</p>
                </div>
              </div>
              <div className="space-y-2">
                {[{ icon: Ear, t: "Listen in" }, { icon: Mic, t: "Whisper coaching" }, { icon: Radio, t: "Barge in" }, { icon: MessageSquareText, t: "Live transcript & sentiment" }].map((b) => (
                  <Button key={b.t} variant="outline" className="w-full justify-between" disabled>
                    <span className="flex items-center gap-2"><b.icon className="h-4 w-4" />{b.t}</span>
                    <SoonBadge />
                  </Button>
                ))}
              </div>
              <Button variant="ghost" size="sm" asChild className="w-full">
                <Link href={`/agents/${selected.agentId}`}>Open agent profile</Link>
              </Button>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard title="Callback queue" icon={ClipboardList} description="Inbound leads no one was free to take — oldest SLA first" action={{ label: "Live queue", href: "/admin/queue" }}>
          {callbacks.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : openCallbacks.length === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="No open callbacks" description="Every inbound lead has been picked up." />
          ) : (
            <ul className="divide-y divide-border/60">
              {openCallbacks.slice(0, 8).map((c) => {
                const sla = slaLabel(c.slaDueAt);
                return (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.carrierName ?? "Unknown carrier"} · {c.stateCode}</span>
                      <span className="text-xs text-muted-foreground">{c.attempts} attempt{c.attempts === 1 ? "" : "s"} · opened {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
                    </span>
                    <StatusPill tone={sla.overdue ? "danger" : "warning"}>{sla.label}</StatusPill>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Coverage gaps (24h)" icon={AlertTriangle} description="Carrier + state combinations where no licensed agent was free">
          {stats.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : gaps.length === 0 ? (
            <EmptyState compact icon={BarChart3} title="No coverage gaps" description={s && s.total > 0 ? `All ${s.total} inbound leads in the last 24 hours found an agent.` : "No inbound leads in the last 24 hours."} />
          ) : (
            <ul className="divide-y divide-border/60">
              {gaps.slice(0, 8).map((g) => (
                <li key={`${g.carrierId}-${g.stateCode}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{g.carrierName ?? "Unknown carrier"} · {g.stateCode}</span>
                    <span className="text-xs text-muted-foreground">Last missed {formatDistanceToNow(new Date(g.lastOccurrence), { addSuffix: true })} · {g.availableNow} eligible agent{g.availableNow === 1 ? "" : "s"} free now</span>
                  </span>
                  <StatusPill tone="danger">{g.noAgentCount} missed</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function CallReview() {
  const productName = useProductName();
  const { data, isLoading, isError } = useSupervisorCallSummaries();
  const rows = data?.data ?? [];
  return (
    <div className="space-y-6">
      <ComingSoonNote title="Call recordings and full transcripts are coming soon with browser calling." icon={Headphones}>
        Below are the post-call summaries {productName} has already produced from connected dialer calls — summary, suggested outcome, risk flags and next steps.
      </ComingSoonNote>
      <SectionCard title="Recent post-call summaries" icon={MessageSquareText} description="Newest first · suggestions are advisory, the agent confirms">
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">Couldn't load call summaries.</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No call summaries yet"
            description={`When a connected dialer sends a call transcript, ${productName} summarises it and it shows up here for review.`}
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.ticketId} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <Link href={`/crm/contacts/${r.contact.id}`} className="font-semibold hover:underline">{r.contact.name}</Link>
                    <span className="text-muted-foreground"> · {r.agent ? r.agent.name : "Agent unknown"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {r.suggestedDisposition && (
                      <StatusPill tone={r.suggestedDisposition.category === "POSITIVE" ? "success" : r.suggestedDisposition.category === "NEGATIVE" || r.suggestedDisposition.category === "COMPLIANCE" ? "danger" : "info"}>
                        {r.suggestedDisposition.category.replace("_", " ").toLowerCase()}
                      </StatusPill>
                    )}
                    <span className="text-xs text-muted-foreground">{r.parsedAt ? format(new Date(r.parsedAt), "MMM d, h:mm a") : ""}</span>
                  </div>
                </div>
                <p className="mt-2 text-sm">{r.summary ?? "No summary text."}</p>
                {r.riskFlags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.riskFlags.map((f, i) => (
                      <StatusPill key={i} tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "neutral"}>
                        <AlertTriangle className="mr-1 h-3 w-3" />{f.kind.replace(/_/g, " ")}
                      </StatusPill>
                    ))}
                  </div>
                )}
                {r.actionItems.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                    {r.actionItems.slice(0, 4).map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

export default function SupervisorPage() {
  const { isAdmin, isLoading, role } = useIsAdmin(SUPERVISOR_ROLES);
  const [tab, setTab] = useState<"floor" | "review">("floor");

  if (!isLoading && role && !isAdmin) return <NoAccess what="the supervisor dashboard" />;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader title="Supervisor Dashboard" subtitle="Live call floor, routing health, callbacks and post-call review">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-1 text-xs font-medium text-success">
          <span className="h-2 w-2 animate-pulse rounded-full bg-success" /> Live
        </span>
      </PageHeader>

      <div className="inline-flex rounded-xl bg-muted p-1" role="tablist" aria-label="Supervisor views">
        {([
          { k: "floor", label: "Live Floor", icon: Headphones },
          { k: "review", label: "Call Review", icon: MessageSquareText },
        ] as const).map((t) => (
          <button
            key={t.k}
            type="button"
            role="tab"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              tab === t.k ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {!isAdmin ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : tab === "floor" ? <LiveFloor /> : <CallReview />}
    </div>
  );
}
