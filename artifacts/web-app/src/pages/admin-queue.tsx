/**
 * Admin "Live Queue" page.
 *
 * Surfaces what the inbound lead queue now records:
 *   - Presence — who is available right now (status='available' within TTL),
 *     plus everyone else's current state.
 *   - Recent decisions — the `lead_routing` audit trail (who got routed where,
 *     candidate-pool size, source), newest first.
 *
 * Restricted to super_admin / agency_admin (non-admins see a no-access panel);
 * the API also requires lead:read. Both panels poll every 15s so the view
 * stays live.
 */
import { useState } from "react";
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import {
  useQueuePresence,
  useRecentRouting,
  useRoutingStats,
  useQueueCallbacks,
  useCancelCallback,
  type PresenceAgent,
  type LeadCallback,
} from "@/lib/queue/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BarChart3, PhoneMissed, Radio, TriangleAlert, Users, Route, PhoneOff, Lock, History, ShieldCheck } from "lucide-react";
import { PageHeader, KpiCard, MiniStat, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame } from "@/components/ops";

const STATUS_LABEL: Record<string, string> = {
  available: "Available",
  on_call: "On call",
  wrap: "Wrap-up",
  away: "Away",
  offline: "Offline",
};

function agentName(a: { firstName: string; lastName: string }): string {
  return `${a.firstName} ${a.lastName}`.trim();
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * SLA countdown for a callback. Returns the label plus whether it is overdue,
 * so the row can render red once `slaDueAt` has passed.
 */
function slaCountdown(slaDueAt: string): { label: string; overdue: boolean } {
  const diffMs = new Date(slaDueAt).getTime() - Date.now();
  const overdue = diffMs <= 0;
  const abs = Math.abs(diffMs);
  const m = Math.round(abs / 60000);
  const label =
    m < 60
      ? `${m}m`
      : `${Math.floor(m / 60)}h ${m % 60}m`;
  return { label: overdue ? `${label} overdue` : `in ${label}`, overdue };
}

function PresenceDot({ agent }: { agent: PresenceAgent }) {
  return (
    <span
      className={cn(
        "h-2.5 w-2.5 rounded-full shrink-0",
        agent.availableNow
          ? "bg-success"
          : agent.status === "on_call" || agent.status === "wrap"
            ? "bg-warning"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

function SummaryCard({
  label,
  value,
  sub,
  alarm,
}: {
  label: string;
  value: string;
  sub?: string;
  alarm?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="text-xs text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "font-display text-2xl font-bold tabular-nums",
          alarm && "text-amber-600 dark:text-warning",
        )}
      >
        {value}
      </div>
      {sub ? (
        <div className="text-[11px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  routed: number;
  noAgent: number;
}

function BreakdownTable({
  title,
  firstHead,
  rows,
}: {
  title: string;
  firstHead: string;
  rows: BreakdownRow[];
}) {
  return (
    <TableFrame>
      <div className="px-4 py-2.5 border-b border-border text-sm font-semibold font-display">{title}</div>
      {rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{firstHead}</TableHead>
              <TableHead className="text-right">Routed</TableHead>
              <TableHead className="text-right">No agent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="truncate max-w-[12rem]">
                  {r.label}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.routed}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.noAgent}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-xs text-muted-foreground py-5 text-center">
          No calls in this window.
        </p>
      )}
    </TableFrame>
  );
}

const WINDOW_OPTIONS: { label: string; hours: number }[] = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function CallbacksPanel({ enabled }: { enabled: boolean }) {
  const callbacks = useQueueCallbacks("open", enabled);
  const cancel = useCancelCallback();
  const rows: LeadCallback[] = callbacks.data?.data ?? [];

  return (
    <SectionCard
      title="Callbacks owed"
      description="Callers we missed and promised to ring back. They're cleared automatically when an agent frees up."
      icon={PhoneMissed}
      iconClassName="text-destructive"
      actions={<StatusPill tone={rows.length > 0 ? "warning" : "success"}>{rows.length} open</StatusPill>}
      contentClassName="space-y-3"
    >
        {callbacks.isLoading ? (
          <div className="space-y-2" data-testid="callbacks-loading">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length > 0 ? (
          <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Carrier</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>SLA</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const sla = slaCountdown(c.slaDueAt);
                return (
                  <TableRow key={c.id}>
                    <TableCell>{c.carrierName ?? c.carrierId}</TableCell>
                    <TableCell>{c.stateCode}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.contactId ?? "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap tabular-nums",
                        sla.overdue
                          ? "text-destructive font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      {sla.label}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.attempts}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2.5 text-xs"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(c.id)}
                      >
                        Cancel
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </TableFrame>
        ) : (
          <EmptyState
            compact
            icon={ShieldCheck}
            title="No callbacks owed — nice"
            description="Every inbound caller was answered or has already been called back."
          />
        )}
    </SectionCard>
  );
}

export default function AdminQueuePage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin();
  const [sinceHours, setSinceHours] = useState(24);
  const presence = useQueuePresence(Boolean(isAdmin));
  const routing = useRecentRouting(50, Boolean(isAdmin));
  const analytics = useRoutingStats(sinceHours, Boolean(isAdmin));

  if (!meLoading && !isAdmin) {
    return (
      <PageShell>
        <SectionCard>
          <EmptyState
            icon={Lock}
            title="You don't have access to the live queue."
            description="The live call queue is available to agency admins."
          />
        </SectionCard>
      </PageShell>
    );
  }

  const availableCount = presence.data?.availableCount ?? 0;

  return (
    <PageShell>
      <PageHeader
        title="Live Call Queue"
        subtitle="Who's free to take a call right now, where inbound calls went, and who we still owe a call back"
      >
        <StatusPill tone="success" className="gap-1.5 text-sm px-3 py-1">
          <span className="h-2 w-2 rounded-full bg-success animate-pulse" /> Updates every 15 seconds
        </StatusPill>
      </PageHeader>

      <KpiGrid>
        <KpiCard
          label="Agents available now"
          value={availableCount}
          icon={Users}
          color="green"
          loading={presence.isLoading}
          hint={`${presence.data?.agents.length ?? 0} agents checked in`}
        />
        <KpiCard
          label={`Calls routed · ${WINDOW_OPTIONS.find((o) => o.hours === sinceHours)?.label}`}
          value={analytics.data?.stats.routed ?? 0}
          icon={Route}
          color="navy"
          loading={analytics.isLoading}
          hint={analytics.data ? `${pct(analytics.data.stats.routedRate)} of ${analytics.data.stats.total} calls` : undefined}
        />
        <KpiCard
          label="Missed — no agent free"
          value={analytics.data?.stats.noAgent ?? 0}
          icon={PhoneOff}
          color="orange"
          loading={analytics.isLoading}
          hint={(analytics.data?.stats.total ?? 0) === 0 ? "No inbound calls in this window" : (analytics.data?.stats.noAgent ?? 0) === 0 ? "Every call found an agent" : "Callers routed to a callback"}
        />
        <KpiCard
          label="Coverage gaps"
          value={analytics.data?.coverageGaps.length ?? 0}
          icon={TriangleAlert}
          color="blue"
          loading={analytics.isLoading}
          hint="Carrier + state with nobody available"
        />
      </KpiGrid>

      {/* Analytics */}
      <SectionCard
        title="Routing analytics"
        description="How inbound calls were handed out"
        icon={BarChart3}
        contentClassName="space-y-4"
        actions={
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {WINDOW_OPTIONS.map((opt) => (
              <Button
                key={opt.hours}
                size="sm"
                variant="ghost"
                className={cn("h-7 px-2.5 text-xs", sinceHours === opt.hours && "bg-background shadow hover:bg-background")}
                onClick={() => setSinceHours(opt.hours)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        }
      >

          {analytics.isLoading ? (
            <div
              className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
              data-testid="analytics-loading"
            >
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : analytics.data ? (
            <>
              {/* Summary cards */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryCard
                  label="Decisions"
                  value={String(analytics.data.stats.total)}
                />
                <SummaryCard
                  label="Routed"
                  value={pct(analytics.data.stats.routedRate)}
                  sub={`${analytics.data.stats.routed} routed`}
                />
                <SummaryCard
                  label="No agent"
                  value={
                    analytics.data.stats.total > 0
                      ? pct(
                          analytics.data.stats.noAgent /
                            analytics.data.stats.total,
                        )
                      : "0%"
                  }
                  sub={`${analytics.data.stats.noAgent} missed`}
                  alarm={analytics.data.stats.noAgent > 0}
                />
                <SummaryCard
                  label="Avg pool (routed)"
                  value={analytics.data.stats.avgCandidatePool.toFixed(1)}
                />
              </div>

              {/* By carrier / by state mini-tables */}
              <div className="grid gap-4 lg:grid-cols-2">
                <BreakdownTable
                  title="By carrier"
                  firstHead="Carrier"
                  rows={analytics.data.stats.byCarrier.map((c) => ({
                    key: c.carrierId,
                    label: c.carrierName ?? c.carrierId,
                    routed: c.routed,
                    noAgent: c.noAgent,
                  }))}
                />
                <BreakdownTable
                  title="By state"
                  firstHead="State"
                  rows={analytics.data.stats.byState.map((s) => ({
                    key: s.stateCode,
                    label: s.stateCode,
                    routed: s.routed,
                    noAgent: s.noAgent,
                  }))}
                />
              </div>

              {/* Coverage gaps */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <TriangleAlert className="h-4 w-4 text-warning" />
                  <span className="font-semibold text-sm font-display">Coverage gaps</span>
                  <span className="text-xs text-muted-foreground">
                    carrier + state combinations with no available agent
                  </span>
                </div>
                {analytics.data.coverageGaps.length > 0 ? (
                  <TableFrame>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Carrier</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead className="text-right">No agent</TableHead>
                        <TableHead className="text-right">
                          Available now
                        </TableHead>
                        <TableHead>Last seen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.data.coverageGaps.map((g) => (
                        <TableRow key={`${g.carrierId}-${g.stateCode}`}>
                          <TableCell>{g.carrierName ?? g.carrierId}</TableCell>
                          <TableCell>{g.stateCode}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {g.noAgentCount}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span
                              className={cn(
                                g.availableNow === 0 &&
                                  "text-destructive font-medium",
                              )}
                            >
                              {g.availableNow}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap">
                            {relativeTime(g.lastOccurrence)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  </TableFrame>
                ) : (
                  <EmptyState
                    compact
                    icon={ShieldCheck}
                    title={analytics.data.stats.total === 0 ? "No coverage gaps in this window" : "No coverage gaps in this window — nice"}
                    description={analytics.data.stats.total === 0 ? "No inbound calls came in yet, so there's nothing to flag." : "Every carrier and state that called had someone available."}
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyState
              compact
              icon={BarChart3}
              title="No routing data yet"
              description="Once inbound calls start coming in, you'll see how they were routed here."
            />
          )}
      </SectionCard>

      {/* Callback SLA queue */}
      <CallbacksPanel enabled={Boolean(isAdmin)} />

      {/* Presence */}
      <SectionCard
        title="Agent presence"
        description="Green is ready for a call, amber is on a call or wrapping up"
        icon={Radio}
        iconClassName="text-success"
        actions={<StatusPill tone={availableCount > 0 ? "success" : "neutral"}>{availableCount} available</StatusPill>}
        contentClassName="space-y-3"
      >
          {presence.isLoading ? (
            <div className="space-y-2" data-testid="presence-loading">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : presence.data && presence.data.agents.length > 0 ? (
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {presence.data.agents.map((a) => (
                <div
                  key={a.agentId}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5"
                >
                  <PresenceDot agent={a} />
                  <span className="text-sm truncate flex-1">
                    {agentName(a)}
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {STATUS_LABEL[a.status] ?? a.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon={Users}
              title="No agents have checked in yet."
              description="Agents appear here as soon as they set themselves available in Mediflow."
            />
          )}
      </SectionCard>

      {/* Recent decisions */}
      <SectionCard title="Recent routing decisions" description="The last 50 inbound calls and who they went to" icon={History}>
          {routing.isLoading ? (
            <div className="space-y-2" data-testid="routing-loading">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : routing.data && routing.data.data.length > 0 ? (
            <TableFrame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Pool</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routing.data.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {relativeTime(d.createdAt)}
                    </TableCell>
                    <TableCell>{d.carrierName ?? d.carrierId}</TableCell>
                    <TableCell>{d.stateCode}</TableCell>
                    <TableCell>
                      {d.status === "routed" ? (
                        <StatusPill tone="success">Routed</StatusPill>
                      ) : (
                        <StatusPill tone="warning">No agent</StatusPill>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.agentId
                        ? agentName({
                            firstName: d.agentFirstName ?? "",
                            lastName: d.agentLastName ?? "",
                          })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.candidatePool}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.source ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </TableFrame>
          ) : (
            <EmptyState
              icon={History}
              title="No routing decisions recorded yet."
              description="Each inbound call is logged here with the agent it went to and how many agents could have taken it."
            />
          )}
      </SectionCard>
    </PageShell>
  );
}
