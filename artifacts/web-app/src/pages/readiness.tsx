/**
 * Admin "Ready to Sell" readiness board.
 *
 * The admin-facing inverse of the inbound router's eligibility predicate: per
 * agent, what makes them ready to sell and what's blocking them. Admins use it
 * to drive onboarding completion and grow the routable pool.
 *
 * Restricted to `ADMIN_OR_COMPLIANCE_ROLES`. Non-admins see a clean "no access"
 * panel; the API also enforces `agent:read`. Data comes from the hand-rolled
 * `useAgentReadiness` hook (GET /api/agents/readiness).
 */
import { useMemo, useState } from "react";
import { useAgentReadiness, type AgentReadiness } from "@/lib/readiness/api";
import {
  useIsAdmin,
  ADMIN_OR_COMPLIANCE_ROLES,
} from "@/lib/auth/useIsAdmin";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

function ReadyBadge({ ready }: { ready: boolean }) {
  return ready ? (
    <Badge
      variant="secondary"
      className="bg-green-100 text-green-800 gap-1"
      data-testid="ready-badge-yes"
    >
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </Badge>
  ) : (
    <Badge
      variant="secondary"
      className="bg-red-100 text-red-800 gap-1"
      data-testid="ready-badge-no"
    >
      <XCircle className="h-3 w-3" />
      Not ready
    </Badge>
  );
}

function AhipCell({ current }: { current: boolean }) {
  return current ? (
    <span className="inline-flex items-center gap-1 text-green-700 text-xs">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Current
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-amber-700 text-xs">
      <AlertCircle className="h-3.5 w-3.5" />
      Missing
    </span>
  );
}

function ReadinessRow({ agent }: { agent: AgentReadiness }) {
  return (
    <TableRow data-testid={`readiness-row-${agent.agentId}`}>
      <TableCell className="font-medium">
        {agent.lastName}, {agent.firstName}
        {agent.npn && (
          <span className="ml-2 text-xs text-muted-foreground">
            NPN {agent.npn}
          </span>
        )}
      </TableCell>
      <TableCell>
        <ReadyBadge ready={agent.readyToSell} />
      </TableCell>
      <TableCell>
        <AhipCell current={agent.ahipCurrent} />
      </TableCell>
      <TableCell className="text-center tabular-nums">
        {agent.licensedStates.length}
      </TableCell>
      <TableCell className="text-center tabular-nums">
        {agent.certifiedCarriers.length}
      </TableCell>
      <TableCell>
        {agent.blockers.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {agent.blockers.map((b) => (
              <Badge
                key={b}
                variant="outline"
                className="text-amber-700 border-amber-300 text-[11px]"
              >
                {b}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function ReadinessPage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(
    ADMIN_OR_COMPLIANCE_ROLES,
  );
  const [notReadyOnly, setNotReadyOnly] = useState(false);

  const readinessQuery = useAgentReadiness(undefined, Boolean(isAdmin));
  const agents = readinessQuery.data?.data ?? [];

  const rows = useMemo(
    () => (notReadyOnly ? agents.filter((a) => !a.readyToSell) : agents),
    [agents, notReadyOnly],
  );

  if (!meLoading && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't have access to the readiness board.
          </CardContent>
        </Card>
      </div>
    );
  }

  const readyCount = readinessQuery.data?.readyCount ?? 0;
  const totalCount = readinessQuery.data?.totalCount ?? 0;
  const certYear = readinessQuery.data?.certificationYear;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Ready to Sell</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Per-agent readiness and blockers — drive onboarding completion and
            grow the routable pool
            {certYear ? ` · cert year ${certYear}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="not-ready-only"
            checked={notReadyOnly}
            onCheckedChange={setNotReadyOnly}
            data-testid="not-ready-only-toggle"
          />
          <Label htmlFor="not-ready-only" className="text-sm">
            Not ready only
          </Label>
        </div>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="py-4">
          {readinessQuery.isLoading ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <p className="text-sm" data-testid="readiness-summary">
              <span className="text-2xl font-bold tabular-nums">
                {readyCount}
              </span>{" "}
              <span className="text-muted-foreground">
                of {totalCount} agents ready to sell
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {readinessQuery.isLoading ? (
            <div className="p-4 space-y-2" data-testid="readiness-loading">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {notReadyOnly
                ? "Every agent is ready to sell."
                : "No agents found."}
            </div>
          ) : (
            <Table data-testid="readiness-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Ready</TableHead>
                  <TableHead>AHIP</TableHead>
                  <TableHead className="text-center"># States</TableHead>
                  <TableHead className="text-center"># Carriers</TableHead>
                  <TableHead>Blockers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <ReadinessRow key={a.agentId} agent={a} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
