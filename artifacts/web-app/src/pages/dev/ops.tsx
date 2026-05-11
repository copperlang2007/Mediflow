/**
 * /dev/ops — operational dashboard.
 *
 * Three sections backed by /api/dev/ops/{queues,recent-errors,workers}.
 * Polled at a moderate cadence so the data stays fresh without hammering
 * the api server. We call customFetch directly — these endpoints aren't
 * in the OpenAPI spec on purpose (no client SDK pollution).
 */
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { AlertTriangle, Cpu, ListChecks } from "lucide-react";

type QueueRow = {
  name: string;
  active: number;
  queued: number;
  completedLast24h: number;
  failedLast24h: number;
};

type WorkerRow = { name: string; lastSeen: string | null };

type ErrorRow = {
  id: string;
  ruleId: string;
  ruleName: string;
  triggerType: string;
  triggerEvent: string | null;
  matchedRecordType: string | null;
  matchedRecordId: string | null;
  actionsExecuted: number | null;
  result: "partial" | "failed";
  errorMessage: string | null;
  executedAt: string;
};

function ageOf(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function QueuesSection() {
  const { data, isLoading } = useQuery<{ queues: QueueRow[] }>({
    queryKey: ["/api/dev/ops/queues"],
    queryFn: () => customFetch<{ queues: QueueRow[] }>("/api/dev/ops/queues"),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ListChecks className="h-4 w-4" /> Queues
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data?.queues?.length ? (
          <p className="text-sm text-muted-foreground">No queues registered.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Queued</TableHead>
                <TableHead className="text-right">Completed (24h)</TableHead>
                <TableHead className="text-right">Failed (24h)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.queues.map((q) => (
                <TableRow key={q.name}>
                  <TableCell className="font-mono text-xs">{q.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.active}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.queued}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {q.completedLast24h}
                  </TableCell>
                  <TableCell
                    className={
                      "text-right tabular-nums " +
                      (q.failedLast24h > 0 ? "text-destructive font-semibold" : "text-muted-foreground")
                    }
                  >
                    {q.failedLast24h}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RecentErrorsSection() {
  const { data, isLoading } = useQuery<{ recent: ErrorRow[]; total: number }>({
    queryKey: ["/api/dev/ops/recent-errors"],
    queryFn: () => customFetch<{ recent: ErrorRow[]; total: number }>("/api/dev/ops/recent-errors"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> Recent automation errors
          {data?.total ? (
            <Badge variant="secondary" className="ml-1">
              {data.total}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data?.recent?.length ? (
          <p className="text-sm text-muted-foreground">No failed runs in scope.</p>
        ) : (
          <div className="space-y-2 max-h-[480px] overflow-y-auto">
            {data.recent.map((row) => (
              <div
                key={row.id}
                className="text-xs border rounded-md p-2.5 flex items-start gap-3"
              >
                <Badge
                  variant={row.result === "failed" ? "destructive" : "secondary"}
                  className="text-[10px] mt-0.5 shrink-0"
                >
                  {row.result}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{row.ruleName}</span>
                    <span className="text-muted-foreground shrink-0">
                      {ageOf(row.executedAt)}
                    </span>
                  </div>
                  {row.errorMessage && (
                    <p className="text-muted-foreground mt-1 break-words">
                      {row.errorMessage}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono">
                    {row.triggerType}
                    {row.matchedRecordType ? ` · ${row.matchedRecordType}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkersSection() {
  const { data, isLoading } = useQuery<{ workers: WorkerRow[] }>({
    queryKey: ["/api/dev/ops/workers"],
    queryFn: () => customFetch<{ workers: WorkerRow[] }>("/api/dev/ops/workers"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Cpu className="h-4 w-4" /> Workers
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data?.workers?.length ? (
          <p className="text-sm text-muted-foreground">No workers registered.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.workers.map((w) => (
              <li
                key={w.name}
                className="flex items-center justify-between text-xs border rounded-md px-3 py-2"
              >
                <span className="font-mono">{w.name}</span>
                <span className="text-muted-foreground">{ageOf(w.lastSeen)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function DevOpsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Ops</h1>
        <p className="text-sm text-muted-foreground">
          Live operational view of background workers and recent failures.
        </p>
      </header>

      <QueuesSection />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentErrorsSection />
        <WorkersSection />
      </div>
    </div>
  );
}
