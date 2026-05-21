/**
 * Admin onboarding dashboard.
 *
 * Lists every active and historical `agent_onboarding_runs` in the org with
 * filtering by status and search by agent name. Provides a "Start new
 * onboarding" dialog to kick off a run for an existing agent.
 *
 * Restricted to `super_admin` / `agency_admin` / `compliance_manager` —
 * the backend enforces this on `GET /onboarding`, but we also gate the UI
 * up-front so non-admin users get a clean "you don't have access" panel
 * rather than an opaque 403.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetMe, useGetAgents, getGetAgentsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search, Plus, ChevronRight, Filter } from "lucide-react";
import {
  onboardingStatusLabel,
  useOnboardingList,
  useStartOnboarding,
  type AgentOnboardingRun,
  type OnboardingStatus,
} from "@/lib/onboarding/api";
import AdminOnboardingDetail from "./admin-onboarding-detail";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "profile_in_progress", label: "Profile in progress" },
  { value: "carriers_selected", label: "Awaiting admin review" },
  { value: "signing", label: "Signing paperwork" },
  { value: "submitted", label: "Submitted" },
  { value: "complete", label: "Complete" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_BADGE: Record<OnboardingStatus, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  profile_in_progress: "bg-blue-50 text-blue-700 border-blue-200",
  carriers_selected: "bg-amber-50 text-amber-800 border-amber-200",
  signing: "bg-violet-50 text-violet-800 border-violet-200",
  submitted: "bg-cyan-50 text-cyan-800 border-cyan-200",
  complete: "bg-green-50 text-green-800 border-green-200",
  cancelled: "bg-red-50 text-red-700 border-red-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

export default function AdminOnboardingPage() {
  const [location] = useLocation();
  const detailMatch = location.match(/^\/admin-onboarding\/([^/]+)$/);
  if (detailMatch) {
    return <AdminOnboardingDetail agentId={detailMatch[1] as string} />;
  }
  return <AdminOnboardingIndex />;
}

function AdminOnboardingIndex() {
  const { data: me } = useGetMe();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  const limit = 25;

  const isAdmin = me && ["super_admin", "agency_admin", "compliance_manager"].includes(me.role);

  const { data, isLoading } = useOnboardingList({
    status: status === "all" ? undefined : status,
    limit,
    offset,
    enabled: Boolean(isAdmin),
  });

  // We need agent names for the table — `GET /onboarding` returns the
  // run row but not the joined agent (the backend left that off to keep
  // the list endpoint cheap). Fetch the agent roster separately and join
  // in JS. With limit=200 + the typical 20-30 row admin list this is
  // effectively a free lookup table.
  const { data: agentsData } = useGetAgents(
    { limit: 200 },
    { query: { enabled: Boolean(isAdmin), queryKey: getGetAgentsQueryKey({ limit: 200 }) } },
  );

  const agentName = useMemo(() => {
    const m = new Map<string, { firstName: string; lastName: string; status: string }>();
    (agentsData?.agents ?? []).forEach((a) =>
      m.set(a.id, { firstName: a.firstName, lastName: a.lastName, status: a.status }),
    );
    return m;
  }, [agentsData]);

  if (me && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't have access to the admin onboarding dashboard.
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = data?.data ?? [];
  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => {
      const a = agentName.get(r.agentId);
      if (!a) return false;
      return `${a.firstName} ${a.lastName}`.toLowerCase().includes(s);
    });
  }, [rows, search, agentName]);

  const total = data?.total ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agent onboarding</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Carrier contracting runs across the org
          </p>
        </div>
        <Button onClick={() => setStartOpen(true)} data-testid="start-onboarding-btn">
          <Plus className="h-4 w-4 mr-2" />
          Start new onboarding
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by agent name…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="onboarding-search"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setOffset(0); }}>
          <SelectTrigger className="w-56" data-testid="onboarding-status-filter">
            <Filter className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No onboarding runs match your filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <OnboardingRow key={r.id} run={r} agentName={agentName.get(r.agentId)} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <StartOnboardingDialog open={startOpen} onClose={() => setStartOpen(false)} />
    </div>
  );
}

function OnboardingRow({
  run,
  agentName,
}: {
  run: AgentOnboardingRun;
  agentName?: { firstName: string; lastName: string; status: string };
}) {
  return (
    <TableRow data-testid={`onboarding-row-${run.id}`}>
      <TableCell>
        <Link
          href={`/admin-onboarding/${run.agentId}`}
          className="text-sm font-medium hover:underline"
        >
          {agentName
            ? `${agentName.firstName} ${agentName.lastName}`
            : `Agent ${run.agentId.slice(0, 8)}…`}
        </Link>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={`text-[10px] capitalize ${STATUS_BADGE[run.status] ?? ""}`}
        >
          {onboardingStatusLabel(run.status)}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(run.startedAt).toLocaleDateString()}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(run.updatedAt).toLocaleDateString()}
      </TableCell>
      <TableCell>
        <Link href={`/admin-onboarding/${run.agentId}`}>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

export function StartOnboardingDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data: agentsData, isLoading: agentsLoading } = useGetAgents(
    { limit: 200 },
    { query: { enabled: open, queryKey: getGetAgentsQueryKey({ limit: 200 }) } },
  );
  const { mutateAsync, isPending } = useStartOnboarding();
  const [, navigate] = useLocation();
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [search, setSearch] = useState("");

  const eligible = useMemo(() => {
    const arr = agentsData?.agents ?? [];
    // Onboarding can be started for any active or onboarding-status agent.
    // Filter out offboarded agents (carriers wouldn't appoint them anyway).
    const filtered = arr.filter(
      (a) => a.status !== "offboarded" && a.status !== "offboarding",
    );
    if (!search.trim()) return filtered;
    const s = search.toLowerCase();
    return filtered.filter((a) =>
      `${a.firstName} ${a.lastName} ${a.email}`.toLowerCase().includes(s),
    );
  }, [agentsData, search]);

  const handleStart = async () => {
    if (!selectedAgentId) return;
    try {
      const result = await mutateAsync({ agentId: selectedAgentId });
      toast.success(
        result.idempotent
          ? "Onboarding already in progress for this agent — opening it"
          : "Onboarding started",
      );
      navigate(`/admin-onboarding/${result.run.agentId}`);
      onClose();
      setSelectedAgentId("");
      setSearch("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start onboarding");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setSelectedAgentId(""); setSearch(""); } }}>
      <DialogContent className="sm:max-w-md" data-testid="start-onboarding-dialog">
        <DialogHeader>
          <DialogTitle>Start carrier contracting onboarding</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search agents…"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="start-onboarding-search"
            />
          </div>

          {agentsLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No matching agents. <Link href="/agents" className="text-primary underline">Add an agent first</Link>.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
              {eligible.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedAgentId(a.id)}
                  className={`w-full text-left p-2.5 hover:bg-muted transition-colors ${
                    selectedAgentId === a.id ? "bg-primary/10" : ""
                  }`}
                  data-testid={`start-onboarding-agent-${a.id}`}
                >
                  <p className="text-sm font-medium">{a.firstName} {a.lastName}</p>
                  <p className="text-xs text-muted-foreground">{a.email}</p>
                </button>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            The agent will be notified and assigned a "complete your contracting
            profile" task.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleStart}
            disabled={!selectedAgentId || isPending}
            data-testid="start-onboarding-confirm"
          >
            {isPending ? "Starting…" : "Start onboarding"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for unit tests.
export { STATUS_BADGE };
