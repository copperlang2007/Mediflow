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
 * NOTE: there is intentionally no "close rate" column — MediFlow records no
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
import { Trophy } from "lucide-react";

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
            ready ? "bg-green-500" : "bg-slate-300"
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

function LeaderboardRow({ entry }: { entry: AgentLeaderboardEntry }) {
  return (
    <TableRow data-testid={`leaderboard-row-${entry.agentId}`}>
      <TableCell className="text-center tabular-nums font-semibold text-muted-foreground">
        {entry.rank}
      </TableCell>
      <TableCell className="font-medium">
        {entry.lastName}, {entry.firstName}
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

  if (!meLoading && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't have access to the agent leaderboard.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="h-6 w-6 text-amber-500" />
            Agent Leaderboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Inbound-routing activity ranked over the selected window — inbounds
            routed, callbacks resolved, and current open-lead load
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={String(sinceHours)}
          onValueChange={(v) => {
            if (v) setSinceHours(Number(v));
          }}
          data-testid="leaderboard-window-toggle"
        >
          {WINDOWS.map((w) => (
            <ToggleGroupItem
              key={w.value}
              value={w.value}
              aria-label={w.label}
            >
              {w.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="p-4 space-y-2" data-testid="leaderboard-loading">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div
              className="py-16 text-center text-sm text-muted-foreground"
              data-testid="leaderboard-empty"
            >
              No active agents to rank.
            </div>
          ) : (
            <Table data-testid="leaderboard-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center w-12">#</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-center">Ready</TableHead>
                  <TableHead className="text-center">Inbounds routed</TableHead>
                  <TableHead className="text-center">
                    Callbacks resolved
                  </TableHead>
                  <TableHead className="text-center">Open leads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <LeaderboardRow key={e.agentId} entry={e} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
