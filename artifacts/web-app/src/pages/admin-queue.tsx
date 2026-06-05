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
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import {
  useQueuePresence,
  useRecentRouting,
  type PresenceAgent,
} from "@/lib/queue/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Radio } from "lucide-react";

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

function PresenceDot({ agent }: { agent: PresenceAgent }) {
  return (
    <span
      className={cn(
        "h-2.5 w-2.5 rounded-full shrink-0",
        agent.availableNow
          ? "bg-emerald-500"
          : agent.status === "on_call" || agent.status === "wrap"
            ? "bg-amber-500"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

export default function AdminQueuePage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin();
  const presence = useQueuePresence(Boolean(isAdmin));
  const routing = useRecentRouting(50, Boolean(isAdmin));

  if (!meLoading && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don&apos;t have access to the live queue.
          </CardContent>
        </Card>
      </div>
    );
  }

  const availableCount = presence.data?.availableCount ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Live Queue</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Real-time agent availability and recent inbound routing decisions.
        </p>
      </div>

      {/* Presence */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-emerald-500" />
            <span className="font-semibold text-sm">Available now</span>
            <Badge variant="secondary" className="ml-1">
              {availableCount}
            </Badge>
          </div>
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
                  className="flex items-center gap-2 rounded-md border px-3 py-2"
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
            <p className="text-sm text-muted-foreground py-4 text-center">
              No agents have checked in yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Recent decisions */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <span className="font-semibold text-sm">Recent routing decisions</span>
          </div>
          {routing.isLoading ? (
            <div className="p-4 space-y-2" data-testid="routing-loading">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : routing.data && routing.data.data.length > 0 ? (
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
                        <Badge variant="secondary">routed</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          no agent
                        </Badge>
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
          ) : (
            <p className="text-sm text-muted-foreground py-16 text-center">
              No routing decisions recorded yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
