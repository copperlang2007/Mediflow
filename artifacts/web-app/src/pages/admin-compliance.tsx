import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useIsAdmin, ADMIN_OR_COMPLIANCE_ROLES } from "@/lib/auth/useIsAdmin";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck, Download, LogIn, FileDown, Lock, Database,
  CheckCircle2, AlertTriangle, Clock, ChevronRight, Users,
  RefreshCcw, FileText, MonitorSmartphone, LogOut,
} from "lucide-react";
import { PageHeader, KpiCard, MiniStat, SectionCard, StatusPill, EmptyState, TechnicalDetails, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame, NoticeBanner } from "@/components/ops";
import { Info, ShieldAlert, XCircle, ListChecks } from "lucide-react";
import { useProductName } from "@/lib/branding/BrandingProvider";

function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const ACTION_TONE: Record<string, StatusTone> = {
  create: "success", update: "info", delete: "danger", export: "warning",
  login: "navy", logout: "neutral", force_logout: "danger", revoke_session: "danger",
  invite_user: "info", import: "info",
};

// ─── Audit Log Tab ────────────────────────────────────────────────────────────
function AuditDiffDialog({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const changes = entry.changes as { from?: Record<string, unknown>; to?: Record<string, unknown> } | null;
  const hasChanges = changes && (changes.from || changes.to);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Badge variant={entry.action === "delete" ? "destructive" : "outline"} className="text-xs">{entry.action}</Badge>
            <span className="text-sm font-normal text-muted-foreground">{entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId}` : ""}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground border-b pb-3">
            <span>User: <span className="text-foreground font-medium">{entry.userFullName ?? entry.userId ?? "—"}</span></span>
            <span>Role: <span className="text-foreground font-medium">{entry.userRole ?? "—"}</span></span>
            <span>Time: <span className="text-foreground font-medium">{new Date(entry.createdAt).toLocaleString()}</span></span>
            <span>IP: <span className="text-foreground font-medium">{entry.ipAddress ?? "—"}</span></span>
          </div>

          {hasChanges ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-semibold text-red-600 mb-1.5">Before</p>
                <pre className="bg-red-50 border border-red-100 rounded p-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-all">
                  {JSON.stringify(changes.from ?? {}, null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-xs font-semibold text-green-600 mb-1.5">After</p>
                <pre className="bg-green-50 border border-green-100 rounded p-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-all">
                  {JSON.stringify(changes.to ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          ) : entry.changes ? (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">Change Data</p>
              <pre className="bg-muted rounded p-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-all">
                {JSON.stringify(entry.changes, null, 2)}
              </pre>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No change data recorded for this event.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AuditLogTab() {
  const [page, setPage] = useState(0);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [filterAction, setFilterAction] = useState<string>("all");
  const [filterResource, setFilterResource] = useState<string>("all");
  const [filterStartDate, setFilterStartDate] = useState<string>("");
  const [filterEndDate, setFilterEndDate] = useState<string>("");
  const [filterUserId, setFilterUserId] = useState<string>("");
  const limit = 50;

  const buildParams = () => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
    if (filterAction && filterAction !== "all") p.set("action", filterAction);
    if (filterResource && filterResource !== "all") p.set("resourceType", filterResource);
    if (filterStartDate) p.set("startDate", filterStartDate);
    if (filterEndDate) p.set("endDate", filterEndDate);
    if (filterUserId.trim()) p.set("userId", filterUserId.trim());
    return p.toString();
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-log", page, filterAction, filterResource, filterStartDate, filterEndDate, filterUserId],
    queryFn: () => apiFetch<AuditLogResponse>(`/api/admin/audit-log?${buildParams()}`),
  });

  const handleExport = async () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const p = new URLSearchParams();
    if (filterStartDate) p.set("startDate", filterStartDate);
    if (filterEndDate) p.set("endDate", filterEndDate);
    if (filterAction && filterAction !== "all") p.set("action", filterAction);
    if (filterResource && filterResource !== "all") p.set("resourceType", filterResource);
    if (filterUserId.trim()) p.set("userId", filterUserId.trim());
    const res = await fetch(`${base}/api/admin/audit-log/export?${p.toString()}`, {
      credentials: "include",
      headers: { "X-Confirm-Export": "true" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
      alert(body.code === "STEP_UP_REQUIRED" ? "Session expired — please reload the page and try again." : (body.error ?? `Export failed (${res.status})`));
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const handleResetFilters = () => {
    setFilterAction("all");
    setFilterResource("all");
    setFilterStartDate("");
    setFilterEndDate("");
    setFilterUserId("");
    setPage(0);
  };

  const RESOURCE_TYPES = ["contact", "agent", "deal", "lead", "pipeline", "stage", "import", "session", "user", "automation", "carrier_cert", "license"];
  const ACTION_TYPES = ["create", "update", "delete", "export", "login", "logout", "force_logout", "revoke_session", "invite_user", "import"];

  return (
    <SectionCard
      title="Audit log"
      description="Every view and change, kept permanently. Click a row to see what changed."
      icon={FileDown}
      actions={
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      }
      contentClassName="space-y-4"
    >
      {/* Filter row */}
      <div className="flex flex-wrap gap-2 items-end rounded-lg bg-muted/40 p-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Action</label>
          <Select value={filterAction} onValueChange={(v) => { setFilterAction(v); setPage(0); }}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All actions" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {ACTION_TYPES.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Resource</label>
          <Select value={filterResource} onValueChange={(v) => { setFilterResource(v); setPage(0); }}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All resources" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All resources</SelectItem>
              {RESOURCE_TYPES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">From</label>
          <input
            type="date"
            value={filterStartDate}
            onChange={(e) => { setFilterStartDate(e.target.value); setPage(0); }}
            className="h-8 px-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">To</label>
          <input
            type="date"
            value={filterEndDate}
            onChange={(e) => { setFilterEndDate(e.target.value); setPage(0); }}
            className="h-8 px-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">User ID</label>
          <input
            type="text"
            placeholder="Filter by user…"
            value={filterUserId}
            onChange={(e) => { setFilterUserId(e.target.value); setPage(0); }}
            className="h-8 px-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring w-40"
          />
        </div>
        {(filterAction !== "all" || filterResource !== "all" || filterStartDate || filterEndDate || filterUserId) && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={handleResetFilters}>
            <RefreshCcw className="h-3 w-3 mr-1" /> Clear
          </Button>
        )}
        {data && <span className="text-xs text-muted-foreground ml-auto">{data.total.toLocaleString()} entries</span>}
      </div>

      {selectedEntry && <AuditDiffDialog entry={selectedEntry} onClose={() => setSelectedEntry(null)} />}

      {isLoading ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Diff</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.entries.map((entry: AuditEntry) => (
                <TableRow key={entry.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setSelectedEntry(entry)}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">{entry.userFullName ?? entry.userId ?? "—"}</TableCell>
                  <TableCell>{entry.userRole ? <StatusPill tone="navy">{humanize(entry.userRole)}</StatusPill> : "—"}</TableCell>
                  <TableCell><StatusPill tone={ACTION_TONE[entry.action] ?? "neutral"}>{humanize(entry.action)}</StatusPill></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId.slice(0, 8)}…` : ""}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.ipAddress ?? "—"}</TableCell>
                  <TableCell>
                    {entry.changes
                      ? <span className="text-xs font-medium text-accent">View</span>
                      : <span className="text-xs text-muted-foreground">—</span>
                    }
                  </TableCell>
                </TableRow>
              ))}
              {data?.entries.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No audit log entries found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableFrame>
      )}

      {data && data.total > limit && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Showing {page * limit + 1}–{Math.min((page + 1) * limit, data.total)} of {data.total.toLocaleString()}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Access Review Tab ────────────────────────────────────────────────────────
function AccessReviewTab() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: users, isLoading } = useQuery({
    queryKey: ["admin", "access-review"],
    queryFn: () => apiFetch<UserRow[]>("/api/admin/access-review"),
  });

  const deactivateMut = useMutation({
    mutationFn: (userId: string) => apiFetch(`/api/admin/users/${userId}/deactivate`, { method: "POST" }),
    onSuccess: () => { toast({ title: "User deactivated" }); qc.invalidateQueries({ queryKey: ["admin", "access-review"] }); },
    onError: () => toast({ title: "Failed to deactivate user", variant: "destructive" }),
  });

  const reactivateMut = useMutation({
    mutationFn: (userId: string) => apiFetch(`/api/admin/users/${userId}/reactivate`, { method: "POST" }),
    onSuccess: () => { toast({ title: "User reactivated" }); qc.invalidateQueries({ queryKey: ["admin", "access-review"] }); },
    onError: () => toast({ title: "Failed to reactivate user", variant: "destructive" }),
  });

  const handleExport = async () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const res = await fetch(`${base}/api/admin/access-review/export`, {
      credentials: "include",
      headers: { "X-Confirm-Export": "true" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
      alert(body.code === "STEP_UP_REQUIRED" ? "Session expired — please reload the page and try again." : (body.error ?? `Export failed (${res.status})`));
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `access-review-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <SectionCard
      title="Access review"
      description="Everyone with a login, their role, and when they last signed in. Deactivate anyone who no longer needs access."
      icon={Users}
      actions={
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      }
    >
      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users?.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.fullName}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                  <TableCell><StatusPill tone="navy">{humanize(user.role)}</StatusPill></TableCell>
                  <TableCell>
                    <StatusPill tone={user.isActive ? "success" : "neutral"}>
                      {user.isActive ? "Active" : "Inactive"}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "Never"}
                  </TableCell>
                  <TableCell>
                    {user.isActive ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive h-7 text-xs">
                            Deactivate
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Deactivate {user.fullName}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will block the user from signing in. Their data will be preserved. You can reactivate them at any time.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deactivateMut.mutate(user.id)} className="bg-destructive text-destructive-foreground">
                              Deactivate
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => reactivateMut.mutate(user.id)}>
                        Reactivate
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

// ─── Login History Tab ────────────────────────────────────────────────────────
function LoginHistoryTab() {
  const [page, setPage] = useState(0);
  const limit = 100;

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "login-history", page],
    queryFn: () => apiFetch<LoginHistoryResponse>(`/api/admin/login-history?limit=${limit}&offset=${page * limit}`),
  });

  const successRate = data ? Math.round((data.events.filter((e: LoginEvent) => e.success).length / (data.events.length || 1)) * 100) : null;

  const handleExport = async () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const res = await fetch(`${base}/api/admin/login-history/export`, {
      credentials: "include",
      headers: { "X-Confirm-Export": "true" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
      alert(body.code === "STEP_UP_REQUIRED" ? "Session expired — please reload the page and try again." : (body.error ?? `Export failed (${res.status})`));
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `login-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      {successRate !== null && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MiniStat label="Sign-in events (all time)" value={data?.total.toLocaleString() ?? "0"} icon={LogIn} />
          <MiniStat label="Success rate (this page)" value={`${successRate}%`} icon={CheckCircle2} tone="success" />
          <MiniStat
            label="Failed attempts (this page)"
            value={data?.events.filter((e: LoginEvent) => !e.success).length ?? 0}
            icon={XCircle}
            tone={(data?.events.filter((e: LoginEvent) => !e.success).length ?? 0) > 0 ? "danger" : "default"}
          />
        </div>
      )}

      <SectionCard
        title="Login history"
        description="Every sign-in attempt with its IP address and, if it failed, why"
        icon={LogIn}
        actions={
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4 mr-1.5" /> Export CSV
          </Button>
        }
      >
      {isLoading ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>User / Email</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>Failure Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.events.map((event: LoginEvent) => (
                <TableRow key={event.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(event.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-sm">{event.email ?? event.userId ?? "—"}</TableCell>
                  <TableCell>
                    {event.success
                      ? <StatusPill tone="success" className="gap-1"><CheckCircle2 className="h-3 w-3" />Success</StatusPill>
                      : <StatusPill tone="danger" className="gap-1"><AlertTriangle className="h-3 w-3" />Failed</StatusPill>
                    }
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{event.ipAddress ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{event.failureReason ?? "—"}</TableCell>
                </TableRow>
              ))}
              {data?.events.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No login events recorded.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableFrame>
      )}
      </SectionCard>
    </div>
  );
}

// ─── Session & Retention Config Tab ──────────────────────────────────────────
function SecurityConfigTab() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: sessionConfig } = useQuery({
    queryKey: ["admin", "session-config"],
    queryFn: () => apiFetch<{ sessionTimeoutMinutes: number }>("/api/admin/session-config"),
  });

  const { data: retentionPolicies } = useQuery({
    queryKey: ["admin", "data-retention"],
    queryFn: () => apiFetch<RetentionPolicy[]>("/api/admin/data-retention"),
  });

  const updateSessionMut = useMutation({
    mutationFn: (minutes: number) => apiFetch("/api/admin/session-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionTimeoutMinutes: minutes }) }),
    onSuccess: () => { toast({ title: "Session timeout updated" }); qc.invalidateQueries({ queryKey: ["admin", "session-config"] }); qc.invalidateQueries({ queryKey: ["auth", "status"] }); },
    onError: () => toast({ title: "Failed to update session config", variant: "destructive" }),
  });

  const updateRetentionMut = useMutation({
    mutationFn: (policy: { recordType: string; retentionDays: number; isEnabled: boolean }) =>
      apiFetch("/api/admin/data-retention", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(policy) }),
    onSuccess: () => { toast({ title: "Retention policy updated" }); qc.invalidateQueries({ queryKey: ["admin", "data-retention"] }); },
    onError: () => toast({ title: "Failed to update retention policy", variant: "destructive" }),
  });

  const RETENTION_LABELS: Record<string, string> = {
    contacts: "Contacts / Members",
    agents: "Agents",
    audit_log: "Audit Log",
    communications: "Communications",
    documents: "Documents",
  };

  return (
    <div className="space-y-6">
      {/* Session Config */}
      <SectionCard
        title="Session timeout"
        description="Sign people out automatically after they've been idle. HIPAA guidance is 30 minutes or less."
        icon={Clock}
      >
          <div className="flex flex-wrap items-center gap-4">
            <Label>Timeout after inactivity:</Label>
            <Select
              value={String(sessionConfig?.sessionTimeoutMinutes ?? 30)}
              onValueChange={(v) => updateSessionMut.mutate(parseInt(v))}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">60 minutes</SelectItem>
              </SelectContent>
            </Select>
            {sessionConfig?.sessionTimeoutMinutes && sessionConfig.sessionTimeoutMinutes <= 30 && (
              <StatusPill tone="success" className="gap-1"><CheckCircle2 className="h-3 w-3" />Within HIPAA guidance</StatusPill>
            )}
          </div>
      </SectionCard>

      {/* Data Retention */}
      <SectionCard
        title="Data retention"
        description={`How long each kind of record is kept. CMS requires Medicare Advantage and Part D records to be kept for 10 years (${CMS_RETENTION_DAYS.toLocaleString()} days), so no policy can delete sooner.`}
        icon={Database}
      >
          <div className="divide-y divide-border rounded-lg border border-border px-4">
            {retentionPolicies?.map((policy) => (
              <div key={policy.recordType} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-sm">{RETENTION_LABELS[policy.recordType] ?? policy.recordType}</p>
                  <p className="text-xs text-muted-foreground">
                    {policy.retentionDays} days ({Math.round(policy.retentionDays / 365 * 10) / 10} years)
                    {policy.retentionDays < CMS_RETENTION_DAYS && (
                      <StatusPill tone="warning" className="ml-2">Below the CMS 10-year minimum — enforced as 10 years</StatusPill>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Select
                    value={String(Math.max(policy.retentionDays, CMS_RETENTION_DAYS))}
                    onValueChange={(v) => updateRetentionMut.mutate({ recordType: policy.recordType, retentionDays: parseInt(v), isEnabled: policy.isEnabled })}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3650">10 years (CMS min)</SelectItem>
                      <SelectItem value="4380">12 years</SelectItem>
                      <SelectItem value="5475">15 years</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={policy.isEnabled}
                      onCheckedChange={(checked) => updateRetentionMut.mutate({ recordType: policy.recordType, retentionDays: Math.max(policy.retentionDays, CMS_RETENTION_DAYS), isEnabled: checked })}
                    />
                    <Label className="text-xs text-muted-foreground">Auto-delete</Label>
                  </div>
                </div>
              </div>
            ))}
            {retentionPolicies && retentionPolicies.length === 0 && (
              <EmptyState compact icon={Database} title="No retention policies yet" description="Default retention applies until you set one." />
            )}
          </div>
      </SectionCard>
    </div>
  );
}

// ─── Readiness checks tab ─────────────────────────────────────────────────────

/**
 * Plain-language titles for the checks GET /api/admin/baa-checklist runs.
 * The server's own label and note (which name tables, files and constants)
 * stay available to admins under "Technical details".
 */
const CONTROL_TITLES: Record<string, string> = {
  audit_logging_enabled: "Activity log is recording",
  phi_masking_active: "Health details are hidden from roles that don't need them",
  object_storage_acl_enforced: "Stored files have an access policy for your agency",
  data_retention_policy_set: "Record-keeping periods are set",
  breach_notification_workflow: "Breach reporting process is in place",
  export_anomaly_alerting: "Alerts for unusual data downloads",
};

const plural = (n: string, one: string, many: string) => `${n} ${n === "1" ? one : many}`;

/** Rewrites the server's check note in everyday words. Unknown notes pass through. */
export function plainControlNote(id: string, note: string | null | undefined): string | null {
  if (id === "phi_masking_active") {
    return "Protected health information is masked for anyone whose role isn't allowed to see it.";
  }
  if (!note) return null;
  if (/query failed/i.test(note)) return "We couldn't run this check just now. Reload the page to try again.";
  let m: RegExpMatchArray | null;
  if (/table not provisioned/i.test(note) || /No ACL policy row/i.test(note)) {
    return "No agency-specific file access policy on file yet. Files are still protected by the storage provider's own access rules.";
  }
  if ((m = note.match(/^(\d+) ACL policy row\(s\) on file/))) {
    return `${plural(m[1], "file access policy", "file access policies")} on file.`;
  }
  if ((m = note.match(/^(\d+) retention policy row\(s\) configured/))) {
    return `${plural(m[1], "record-keeping rule", "record-keeping rules")} set.`;
  }
  if (/^No retention rows/.test(note)) {
    return "No custom rules yet, so the standard record-keeping periods (5–7 years) apply.";
  }
  if ((m = note.match(/^(\d+) exports in last 30d but no anomaly alerts/))) {
    return `${plural(m[1], "download", "downloads")} in the last 30 days but no unusual-activity alerts yet. Ask whoever runs your install to confirm the automatic check is running.`;
  }
  if ((m = note.match(/^(\d+) anomaly alert\(s\) recorded in last 30d/))) {
    return `${plural(m[1], "unusual-download alert", "unusual-download alerts")} in the last 30 days — the automatic check is working.`;
  }
  if (/^No export traffic in last 30d/.test(note)) return "No data downloads in the last 30 days, so nothing to alert on.";
  if ((m = note.match(/^(\d+) audit entries in last 24h/))) {
    return `${plural(m[1], "activity recorded", "activities recorded")} in the last 24 hours.`;
  }
  if (/^No audit entries in last 24h/.test(note)) return "Nothing recorded in the last 24 hours.";
  if ((m = note.match(/^(\d+) resolved breach record\(s\); (\d+) reported in last 90d/))) {
    return `${plural(m[1], "resolved breach record", "resolved breach records")}; ${m[2]} reported in the last 90 days.`;
  }
  if ((m = note.match(/^(\d+) unresolved breaches reported in last 90d/))) {
    return `${plural(m[1], "unresolved breach", "unresolved breaches")} reported in the last 90 days.`;
  }
  return note;
}
const BAA_STATUS_LABEL: Record<BaaStatus, string> = {
  pass: "Pass",
  warn: "Needs review",
  partial: "Partial",
  fail: "Fail",
};

const BAA_STATUS_TONE: Record<BaaStatus, StatusTone> = {
  pass: "success",
  warn: "warning",
  partial: "warning",
  fail: "danger",
};

export function BaaSoc2Tab() {
  const { toast } = useToast();
  const [generating, setGenerating] = useState(false);

  // The endpoint returns `{ controls, overall, generatedAt }`, each control
  // computed live from DB state with a pass/warn/partial/fail status.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "baa-checklist"],
    queryFn: () => apiFetch<BaaChecklistResponse>("/api/admin/baa-checklist"),
  });
  const controls = data?.controls ?? [];

  const passing = controls.filter((c) => c.status === "pass").length;
  const attention = controls.filter((c) => c.status !== "pass").length;
  const total = controls.length;

  const generatePdf = async () => {
    setGenerating(true);
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/admin/soc2-evidence-pack`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Failed to generate");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `security-evidence-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      toast({ title: "Evidence pack downloaded" });
    } catch {
      toast({ title: "Couldn't create the evidence pack. Try again.", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const statusIcon = (status: BaaStatus) => {
    const tile = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg";
    if (status === "pass") return <div className={`${tile} bg-success/15 text-success`}><CheckCircle2 className="h-5 w-5" /></div>;
    if (status === "fail") return <div className={`${tile} bg-destructive/10 text-destructive`}><XCircle className="h-5 w-5" /></div>;
    return <div className={`${tile} bg-warning/15 text-warning`}><AlertTriangle className="h-5 w-5" /></div>;
  };
  const pct = total > 0 ? Math.round((passing / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <KpiGrid cols={3}>
        <KpiCard
          label="Controls passing"
          value={<span data-testid="baa-passing">{passing}/{total}</span>}
          icon={CheckCircle2}
          color="green"
          loading={isLoading}
          hint={total > 0 ? `${pct}% of the checks we run` : "Checks run when this page loads"}
        />
        <KpiCard
          label="Needs attention"
          value={<span data-testid="baa-attention">{attention}/{total}</span>}
          icon={AlertTriangle}
          color="orange"
          loading={isLoading}
          hint={attention === 0 && total > 0 ? "Nothing to fix — nice" : "See the notes below"}
        />
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Evidence pack</p>
              <p className="text-sm text-muted-foreground mt-1">A PDF of these checks and your audit history to hand to an auditor</p>
            </div>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground">
              <FileText className="h-5 w-5" />
            </div>
          </div>
          <Button size="sm" onClick={generatePdf} disabled={generating} className="self-start">
            {generating ? <RefreshCcw className="h-4 w-4 mr-1.5 animate-spin" /> : <FileText className="h-4 w-4 mr-1.5" />}
            {generating ? "Generating…" : "Generate PDF"}
          </Button>
        </div>
      </KpiGrid>

      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}</div>
      ) : isError ? (
        <SectionCard>
          <EmptyState icon={ShieldAlert} title="Couldn't load the BAA checklist. Try again in a moment." />
        </SectionCard>
      ) : (
        <SectionCard
          title="HIPAA readiness checks"
          description={data?.generatedAt ? `Checked live from your settings · ${new Date(data.generatedAt).toLocaleString()}` : "Checked live from your settings"}
          icon={ListChecks}
          contentClassName="space-y-2"
        >
            {controls.length === 0 && (
              <EmptyState compact icon={ListChecks} title="No controls to show" description="The checklist didn't return any checks for this agency." />
            )}
            {controls.map((control) => (
              <div key={control.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card" data-testid={`baa-control-${control.id}`}>
                {statusIcon(control.status)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{CONTROL_TITLES[control.id] ?? control.label}</p>
                  {plainControlNote(control.id, control.note) && (
                    <p className="text-xs text-muted-foreground mt-0.5">{plainControlNote(control.id, control.note)}</p>
                  )}
                  <TechnicalDetails className="mt-1">
                    <div>check: {control.id}</div>
                    <div>{control.label}</div>
                    {control.note && <div>{control.note}</div>}
                  </TechnicalDetails>
                </div>
                <StatusPill tone={BAA_STATUS_TONE[control.status] ?? "neutral"} className="shrink-0">
                  {BAA_STATUS_LABEL[control.status] ?? control.status}
                </StatusPill>
              </div>
            ))}
        </SectionCard>
      )}
    </div>
  );
}

// ─── Sessions Tab ─────────────────────────────────────────────────────────────
function SessionsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ["admin", "access-review"],
    queryFn: () => apiFetch<UserRow[]>("/api/admin/access-review"),
  });

  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ["admin", "sessions", expandedUserId],
    queryFn: () =>
      expandedUserId
        ? apiFetch<AuthSession[]>(`/api/admin/users/${expandedUserId}/sessions`)
        : Promise.resolve<AuthSession[]>([]),
    enabled: !!expandedUserId,
  });

  const forceLogoutMut = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ success: boolean; revokedCount: number }>(
        `/api/admin/users/${userId}/force-logout`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      toast({ title: `Force logout complete — ${data.revokedCount} session(s) revoked` });
      qc.invalidateQueries({ queryKey: ["admin", "sessions"] });
    },
    onError: () => toast({ title: "Failed to force logout", variant: "destructive" }),
  });

  const revokeSessionMut = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch(`/api/admin/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Session revoked" });
      qc.invalidateQueries({ queryKey: ["admin", "sessions", expandedUserId] });
    },
    onError: () => toast({ title: "Failed to revoke session", variant: "destructive" }),
  });

  return (
    <SectionCard
      title="Active sessions"
      description="See where people are signed in. Force logout ends every session for that person straight away."
      icon={MonitorSmartphone}
    >
      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}</div>
      ) : (
        <div className="space-y-2">
          {users?.filter((u) => u.isActive).map((user) => (
            <Card key={user.id} className={expandedUserId === user.id ? "border-accent/40 shadow-none" : "shadow-none"}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground flex items-center justify-center text-xs font-semibold">
                      {user.fullName.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{user.fullName}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">{user.email} <StatusPill tone="navy">{humanize(user.role)}</StatusPill></p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setExpandedUserId(expandedUserId === user.id ? null : user.id)}
                    >
                      <MonitorSmartphone className="h-3.5 w-3.5 mr-1.5" />
                      {expandedUserId === user.id ? "Hide" : "View"} Sessions
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs text-destructive hover:text-destructive"
                          disabled={forceLogoutMut.isPending}
                        >
                          <LogOut className="h-3.5 w-3.5 mr-1.5" />
                          Force Logout
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Force logout {user.fullName}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will immediately revoke all active sessions for this user. They will need to sign in again.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => forceLogoutMut.mutate(user.id)}
                            className="bg-destructive text-destructive-foreground"
                          >
                            Force Logout
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>

                {expandedUserId === user.id && (
                  <div className="mt-4 border-t pt-4">
                    {sessionsLoading ? (
                      <div className="space-y-2">
                        {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
                      </div>
                    ) : !sessions?.length ? (
                      <p className="text-sm text-muted-foreground text-center py-3">No active sessions found.</p>
                    ) : (
                      <div className="space-y-2">
                        {sessions.map((session) => (
                          <div key={session.sessionId} className="flex items-center justify-between p-3 bg-muted/40 rounded-lg text-xs">
                            <div className="space-y-0.5">
                              <p className="font-medium">Session <span className="font-mono text-muted-foreground">{session.sessionId.slice(-8)}</span></p>
                              <p className="text-muted-foreground">
                                Active: {new Date(session.lastActiveAt).toLocaleString()} ·
                                Expires: {new Date(session.expireAt).toLocaleString()}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-destructive hover:text-destructive"
                              onClick={() => revokeSessionMut.mutate(session.sessionId)}
                              disabled={revokeSessionMut.isPending}
                            >
                              Revoke
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Export Log Tab ───────────────────────────────────────────────────────────
function ExportLogTab() {
  const productName = useProductName();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "export-log"],
    queryFn: () => apiFetch<ExportLogResponse>("/api/admin/export-log?limit=100"),
  });

  return (
    <SectionCard
      title="Export log"
      description={`Every time someone downloads data from ${productName}, it's recorded here`}
      icon={Download}
    >
      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Export Type</TableHead>
                <TableHead>Records</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.exports.map((entry: ExportEntry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-sm">{entry.userFullName ?? entry.userId ?? "—"}</TableCell>
                  <TableCell><StatusPill tone="info">{humanize(entry.exportType)}</StatusPill></TableCell>
                  <TableCell className="text-sm">{entry.recordCount?.toLocaleString() ?? "—"}</TableCell>
                </TableRow>
              ))}
              {data?.exports.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No data exports recorded yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

// Types
type AuditEntry = { id: string; createdAt: string; userId: string | null; userFullName: string | null; userRole: string | null; action: string; resourceType: string; resourceId: string | null; ipAddress: string | null; changes?: unknown };
type AuditLogResponse = { entries: AuditEntry[]; total: number; limit: number; offset: number };
type UserRow = { id: string; email: string; fullName: string; role: string; isActive: boolean; lastLoginAt: string | null; createdAt: string };
type LoginEvent = { id: string; email: string | null; userId: string | null; success: boolean; ipAddress: string | null; failureReason: string | null; createdAt: string };
type LoginHistoryResponse = { events: LoginEvent[]; total: number };
/** CMS 10-year record retention floor — mirrors the server's CMS_RECORD_RETENTION_DAYS. */
const CMS_RETENTION_DAYS = 3650;

type RetentionPolicy = { id: string | null; orgId: string; recordType: string; retentionDays: number; isEnabled: boolean };
type BaaStatus = "pass" | "warn" | "partial" | "fail";
type BaaControl = { id: string; label: string; status: BaaStatus; note?: string; evidenceUrl?: string };
type BaaChecklistResponse = { controls: BaaControl[]; overall: BaaStatus; generatedAt: string };
type ExportEntry = { id: string; userId: string | null; userFullName: string | null; exportType: string; recordCount: number | null; createdAt: string };
type ExportLogResponse = { exports: ExportEntry[]; total: number };
type AuthSession = { sessionId: string; createdAt: string; lastActiveAt: string; expireAt: string; status: string };

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function AdminCompliancePage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(ADMIN_OR_COMPLIANCE_ROLES);
  const productName = useProductName();

  if (!meLoading && !isAdmin) {
    return (
      <PageShell>
        <SectionCard>
          <EmptyState
            icon={Lock}
            title="You don't have access to this page."
            description="Security and HIPAA controls are available to agency admins and compliance managers."
          />
        </SectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Security & HIPAA readiness checks"
        subtitle="Live security checks, who can get in, and a record of every sign-in, change and export"
      />

      <NoticeBanner icon={Info} title="These are live checks, not a certification">
        Each check below is worked out from your agency's real settings every time this page loads. Passing
        them doesn't make {productName} or your agency certified under any security or compliance standard;
        the evidence pack gives your own auditor the facts they'll ask for.
      </NoticeBanner>

      <Tabs defaultValue="baa-soc2">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="baa-soc2" className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Readiness checks
          </TabsTrigger>
          <TabsTrigger value="audit-log" className="flex items-center gap-1.5">
            <FileDown className="h-3.5 w-3.5" /> Audit Log
          </TabsTrigger>
          <TabsTrigger value="sessions" className="flex items-center gap-1.5">
            <MonitorSmartphone className="h-3.5 w-3.5" /> Sessions
          </TabsTrigger>
          <TabsTrigger value="access-review" className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> Access Review
          </TabsTrigger>
          <TabsTrigger value="login-history" className="flex items-center gap-1.5">
            <LogIn className="h-3.5 w-3.5" /> Login History
          </TabsTrigger>
          <TabsTrigger value="export-log" className="flex items-center gap-1.5">
            <FileDown className="h-3.5 w-3.5" /> Export Log
          </TabsTrigger>
          <TabsTrigger value="security-config" className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" /> Security Config
          </TabsTrigger>
        </TabsList>

        <div className="mt-6">
          <TabsContent value="baa-soc2"><BaaSoc2Tab /></TabsContent>
          <TabsContent value="audit-log"><AuditLogTab /></TabsContent>
          <TabsContent value="sessions"><SessionsTab /></TabsContent>
          <TabsContent value="access-review"><AccessReviewTab /></TabsContent>
          <TabsContent value="login-history"><LoginHistoryTab /></TabsContent>
          <TabsContent value="export-log"><ExportLogTab /></TabsContent>
          <TabsContent value="security-config"><SecurityConfigTab /></TabsContent>
        </div>
      </Tabs>
    </PageShell>
  );
}
