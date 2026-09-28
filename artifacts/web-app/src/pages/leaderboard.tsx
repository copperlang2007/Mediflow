/**
 * Admin agent activity leaderboard / scorecard.
 *
 * Ranks the org's active agents by inbound-routing activity over a rolling
 * window — inbounds routed, callbacks resolved, current open-lead load — with a
 * ready-to-sell dot. The operational follow-on to the readiness board: who has
 * actually been doing the inbound work lately and how loaded they are now.
 *
 * Restricted to `ADMIN_OR_COMPLIANCE_ROLES`. Non-admins see a clean "no access"
 * panel; the API also enforces `agent:read`. Data comes from the hand-rolled
 * `useAgentLeaderboard` hook (GET /api/agents/leaderboard).
 *
 * NOTE: there is intentionally no "close rate" column — agencyBRIDGE records no
 * per-call outcomes yet, so conversion is not derivable (see the read model).
 */
import { useState } from "react";
import {
  useAgentLeaderboard,
  type AgentLeaderboardEntry,
} from "@/lib/agents/leaderboardApi";
import {
  useIsAdmin,
  ADMIN_OR_COMPLIANCE_ROLES,
} from "@/lib/auth/useIsAdmin";
import { Card, CardContent } from "@/components/ui/card";
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
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Trophy, Users, PhoneIncoming, PhoneCall, Inbox, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader, KpiCard, SectionCard, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame } from "@/components/ops";

// Window options for the activity metrics (label → hours).
const WINDOWS = [
  { value: "24", label: "24h" },
  { value: "168", label: "7d" },
  { value: "720", label: "30d" },
] as const;

function ReadyDot({ ready }: { ready: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            ready ? "bg-success" : "bg-muted-foreground/30"
          }`}
          data-testid={ready ? "ready-dot-yes" : "ready-dot-no"}
          aria-label={ready ? "Ready to sell" : "Not ready to sell"}
        />
      </TooltipTrigger>
      <TooltipContent>
        {ready ? "Ready to sell" : "Not ready to sell"}
      </TooltipContent>
    </Tooltip>
  );
}

const MEDAL: Record<number, string> = {
  1: "bg-warning/20 text-amber-700 dark:text-warning",
  2: "bg-slate-200 text-slate-700 dark:bg-secondary dark:text-secondary-foreground",
  3: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
};

function LeaderboardRow({ entry }: { entry: AgentLeaderboardEntry }) {
  return (
    <TableRow data-testid={`leaderboard-row-${entry.agentId}`}>
      <TableCell className="text-center">
        <span
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold tabular-nums",
            MEDAL[entry.rank] ?? "text-muted-foreground",
          )}
        >
          {entry.rank}
        </span>
      </TableCell>
      <TableCell className="font-medium">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-800 text-xs font-semibold dark:bg-secondary dark:text-secondary-foreground">
            {`${entry.firstName?.[0] ?? ""}${entry.lastName?.[0] ?? ""}`.toUpperCase()}
          </span>
          {entry.lastName}, {entry.firstName}
        </div>
      </TableCell>
      <TableCell className="text-center">
        <ReadyDot ready={entry.readyToSell} />
      </TableCell>
      <TableCell className="text-center tabular-nums font-semibold">
        {entry.inboundsRouted}
      </TableCell>
      <TableCell className="text-center tabular-nums">
        {entry.callbacksResolved}
      </TableCell>
      <TableCell className="text-center tabular-nums">
        {entry.leadContacts ?? 0}
      </TableCell>
      <TableCell className="text-center tabular-nums text-muted-foreground">
        {entry.openLeads}
      </TableCell>
    </TableRow>
  );
}

export default function LeaderboardPage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(
    ADMIN_OR_COMPLIANCE_ROLES,
  );
  const [sinceHours, setSinceHours] = useState(168);

  const query = useAgentLeaderboard(sinceHours, Boolean(isAdmin));
  const rows = query.data?.data ?? [];
  const windowLabel = WINDOWS.find((w) => w.value === String(sinceHours))?.label ?? "";
  const totalInbounds = rows.reduce((s, r) => s + r.inboundsRouted, 0);
  const totalCallbacks = rows.reduce((s, r) => s + r.callbacksResolved, 0);
  // Same "lead" as the dashboard and Clients & Leads: contacts at the Lead
  // stage. The queue column below is the inbound router's workload.
  const totalLeads = rows.reduce((s, r) => s + (r.leadContacts ?? 0), 0);
  const readyCount = rows.filter((r) => r.readyToSell).length;

  if (!meLoading && !isAdmin) {
    return (
      <PageShell>
        <SectionCard>
          <EmptyState
            icon={Lock}
            title="You don't have access to the agent leaderboard."
            description="The leaderboard is available to agency admins and compliance managers."
          />
        </SectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Agent Leaderboard"
        subtitle="Who's been taking inbound calls and closing callbacks, and how many leads each agent has now"
      >
        <ToggleGroup
          type="single"
          value={String(sinceHours)}
          onValueChange={(v) => {
            if (v) setSinceHours(Number(v));
          }}
          className="rounded-lg bg-muted p-1"
          data-testid="leaderboard-window-toggle"
        >
          {WINDOWS.map((w) => (
            <ToggleGroupItem
              key={w.value}
              value={w.value}
              aria-label={w.label}
              className="h-8 px-3 text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow data-[state=on]:ring-1 data-[state=on]:ring-border"
            >
              {w.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PageHeader>

      <KpiGrid>
        <KpiCard label="Agents ranked" value={rows.length} icon={Users} color="navy" loading={query.isLoading} hint={`${readyCount} ready to sell`} />
        <KpiCard label={`Inbounds routed · ${windowLabel}`} value={totalInbounds} icon={PhoneIncoming} color="blue" loading={query.isLoading} hint={totalInbounds === 0 ? "No inbound calls in this window" : "Calls sent to an agent"} />
        <KpiCard label={`Callbacks resolved · ${windowLabel}`} value={totalCallbacks} icon={PhoneCall} color="green" loading={query.isLoading} hint="Promised call-backs completed" />
        <KpiCard label="Leads assigned" value={totalLeads} icon={Inbox} color="orange" loading={query.isLoading} hint="Clients at the Lead stage, across ranked agents" />
      </KpiGrid>

      <SectionCard title="Rankings" description="Ranked by inbound calls routed; ties go to the agent with fewer open queue leads" icon={Trophy} iconClassName="text-warning">
          {query.isLoading ? (
            <div className="space-y-2" data-testid="leaderboard-loading">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div data-testid="leaderboard-empty">
              <EmptyState
                icon={Trophy}
                title="No active agents to rank."
                description="Once agents are active and taking inbound calls, they'll be ranked here."
              />
            </div>
          ) : (
            <TableFrame>
            <Table data-testid="leaderboard-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center w-16">Rank</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-center">Ready</TableHead>
                  <TableHead className="text-center">Inbounds routed</TableHead>
                  <TableHead className="text-center">
                    Callbacks resolved
                  </TableHead>
                  <TableHead className="text-center">Leads</TableHead>
                  <TableHead className="text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="underline decoration-dotted underline-offset-2">Open queue leads</span>
                      </TooltipTrigger>
                      <TooltipContent>Inbound Live Call Queue leads still new, contacted or qualified</TooltipContent>
                    </Tooltip>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <LeaderboardRow key={e.agentId} entry={e} />
                ))}
              </TableBody>
            </Table>
            </TableFrame>
          )}
      </SectionCard>
    </PageShell>
  );
}
