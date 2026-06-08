/**
 * Queue Wallboard — "TV mode" for the call-center floor.
 *
 * A full-bleed, high-contrast, large-type read-only view of the inbound lead
 * queue intended for a wall-mounted display. It reuses the existing live-queue
 * read hooks (`useQueuePresence`, `useRoutingStats`) — no new backend — and
 * leans on their built-in polling so the board stays current without any manual
 * refresh. A clock and a "updated Xs ago" indicator make the liveness obvious
 * from across the room.
 *
 * Restricted to super_admin / agency_admin (non-admins see the standard
 * no-access panel); the underlying API also enforces lead:read.
 */
import { useEffect, useState } from "react";
import { useIsAdmin, ADMIN_ROLES } from "@/lib/auth/useIsAdmin";
import {
  useQueuePresence,
  useRoutingStats,
  type PresenceAgent,
} from "@/lib/queue/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

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

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** "12s ago" / "3m ago" — coarse, refreshed by the page's own ticking clock. */
function secondsAgo(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * A live wall-clock + "updated" pill. We tick a local `now` every second so the
 * relative-time label and clock stay smooth even between the hooks' polls.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** A big metric tile. `tone` drives the accent colour for at-a-distance read. */
function Tile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "warn" | "alarm";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "alarm"
          ? "text-rose-400"
          : "text-white";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-6 py-5">
      <div className="text-sm font-semibold uppercase tracking-[0.2em] text-white/50">
        {label}
      </div>
      <div className={cn("mt-2 text-6xl font-black tabular-nums", toneClass)}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-lg text-white/60">{sub}</div> : null}
    </div>
  );
}

function StatusPill({
  label,
  count,
  dotClass,
}: {
  label: string;
  count: number;
  dotClass: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2">
      <span className={cn("h-3 w-3 rounded-full", dotClass)} />
      <span className="text-xl font-bold tabular-nums text-white">{count}</span>
      <span className="text-base text-white/60">{label}</span>
    </div>
  );
}

export default function QueueWallboardPage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(ADMIN_ROLES);
  const enabled = Boolean(isAdmin);
  const presence = useQueuePresence(enabled);
  const analytics = useRoutingStats(24, enabled);
  const now = useNow();

  if (!meLoading && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent
            className="py-10 text-center text-sm text-muted-foreground"
            data-testid="wallboard-forbidden"
          >
            You don&apos;t have access to the queue wallboard.
          </CardContent>
        </Card>
      </div>
    );
  }

  const agents = presence.data?.agents ?? [];
  const availableCount = presence.data?.availableCount ?? 0;
  const availableAgents = agents.filter((a) => a.availableNow);
  const onCallCount = agents.filter(
    (a) => a.status === "on_call" || a.status === "wrap",
  ).length;
  const awayCount = agents.filter(
    (a) => !a.availableNow && a.status !== "on_call" && a.status !== "wrap",
  ).length;

  const stats = analytics.data?.stats;
  const total = stats?.total ?? 0;
  const noAgentRate = total > 0 ? (stats?.noAgent ?? 0) / total : 0;
  const coverageGaps = (analytics.data?.coverageGaps ?? []).slice(0, 8);
  const hasGaps = coverageGaps.length > 0;

  const clock = new Date(now).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const live = presence.isFetching || analytics.isFetching;

  return (
    <div
      className="min-h-full bg-slate-950 text-white p-8"
      data-testid="wallboard"
    >
      {/* Header: title + live clock */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-black tracking-tight">Inbound Queue</h1>
          <p className="mt-1 text-lg text-white/50">
            Live floor wallboard · last 24 hours
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2">
            <span
              className={cn(
                "h-3 w-3 rounded-full",
                live ? "bg-emerald-400 animate-pulse" : "bg-emerald-500/70",
              )}
            />
            <span className="text-base font-medium text-white/70">
              updated {secondsAgo(presence.data?.asOf, now)}
            </span>
          </div>
          <div
            className="text-5xl font-black tabular-nums"
            data-testid="wallboard-clock"
          >
            {clock}
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* Available now — the hero panel */}
        <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-sm font-semibold uppercase tracking-[0.2em] text-white/50">
                Available now
              </div>
              <div
                className={cn(
                  "mt-1 text-8xl font-black tabular-nums leading-none",
                  availableCount > 0 ? "text-emerald-400" : "text-rose-400",
                )}
                data-testid="wallboard-available-count"
              >
                {availableCount}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <StatusPill
                label="on call"
                count={onCallCount}
                dotClass="bg-amber-400"
              />
              <StatusPill
                label="away / offline"
                count={awayCount}
                dotClass="bg-white/30"
              />
            </div>
          </div>

          {/* Grid of available agents */}
          <div className="mt-6">
            {availableAgents.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {availableAgents.map((a: PresenceAgent) => (
                  <div
                    key={a.agentId}
                    className="flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3"
                  >
                    <span className="h-3.5 w-3.5 rounded-full bg-emerald-400 shrink-0" />
                    <span className="text-xl font-semibold truncate">
                      {agentName(a)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-6 py-10 text-center text-2xl font-bold text-rose-300">
                No agents available
              </div>
            )}
          </div>
        </div>

        {/* Today's routing tiles */}
        <div className="grid gap-4 content-start">
          <Tile label="Decisions" value={String(total)} sub="last 24h" />
          <Tile
            label="Routed"
            value={stats ? pct(stats.routedRate) : "—"}
            sub={stats ? `${stats.routed} routed` : undefined}
            tone="good"
          />
          <Tile
            label="No agent"
            value={total > 0 ? pct(noAgentRate) : "0%"}
            sub={stats ? `${stats.noAgent} missed` : undefined}
            tone={stats && stats.noAgent > 0 ? "alarm" : "default"}
          />
        </div>
      </div>

      {/* Coverage gaps strip */}
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "h-3 w-3 rounded-full",
              hasGaps ? "bg-rose-400 animate-pulse" : "bg-emerald-400",
            )}
          />
          <span className="text-sm font-semibold uppercase tracking-[0.2em] text-white/50">
            Coverage gaps
          </span>
          <span className="text-base text-white/40">
            carrier × state with no available agent
          </span>
        </div>
        {hasGaps ? (
          <div
            className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            data-testid="wallboard-gaps"
          >
            {coverageGaps.map((g) => (
              <div
                key={`${g.carrierId}-${g.stateCode}`}
                className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xl font-bold truncate">
                    {g.carrierName ?? g.carrierId}
                  </span>
                  <span className="text-2xl font-black tabular-nums text-rose-300 shrink-0">
                    {g.stateCode}
                  </span>
                </div>
                <div className="mt-1 text-base text-white/60">
                  {g.noAgentCount} missed · {g.availableNow} available
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 text-2xl font-bold text-emerald-400">
            Full coverage — no gaps in the last 24h
          </div>
        )}
      </div>
    </div>
  );
}
