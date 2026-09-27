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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Complete immutable audit trail. Click any row to view before/after diff.</p>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2 items-end">
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
        <Card>
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
                  <TableCell><Badge variant="secondary" className="text-xs">{entry.userRole ?? "—"}</Badge></TableCell>
                  <TableCell><Badge variant={entry.action === "delete" || entry.action === "force_logout" ? "destructive" : "outline"} className="text-xs">{entry.action}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId.slice(0, 8)}…` : ""}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.ipAddress ?? "—"}</TableCell>
                  <TableCell>
                    {entry.changes
                      ? <Badge variant="secondary" className="text-xs cursor-pointer">View</Badge>
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
        </Card>
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
    </div>
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Review all user accounts, roles, and access status.</p>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <Card>
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
                  <TableCell><Badge variant="secondary" className="text-xs">{user.role}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={user.isActive ? "default" : "secondary"} className={user.isActive ? "bg-green-100 text-green-800 text-xs" : "text-xs"}>
                      {user.isActive ? "Active" : "Inactive"}
                    </Badge>
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
        </Card>
      )}
    </div>
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
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Authentication event log with IP, device, and success/failure tracking.</p>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      </div>

      {successRate !== null && (
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Total Events</p><p className="text-2xl font-bold">{data?.total.toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Success Rate</p><p className="text-2xl font-bold text-green-600">{successRate}%</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Failed Attempts</p><p className="text-2xl font-bold text-red-500">{data?.events.filter((e: LoginEvent) => !e.success).length ?? 0}</p></CardContent></Card>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <Card>
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
                      ? <Badge className="bg-green-100 text-green-800 text-xs"><CheckCircle2 className="h-3 w-3 mr-1" />Success</Badge>
                      : <Badge variant="destructive" className="text-xs"><AlertTriangle className="h-3 w-3 mr-1" />Failed</Badge>
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
        </Card>
      )}
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
    onSuccess: () => { toast({ title: "Session timeout updated" }); qc.invalidateQueries({ queryKey: ["admin", "session-config"] }); },
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5 text-blue-500" /> Session Timeout</CardTitle>
          <CardDescription>Configure inactivity timeout for all users. HIPAA recommends ≤ 30 minutes.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
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
              <Badge className="bg-green-100 text-green-800 text-xs"><CheckCircle2 className="h-3 w-3 mr-1" />HIPAA Compliant</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Data Retention */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database className="h-5 w-5 text-purple-500" /> Data Retention Policies</CardTitle>
          <CardDescription>Configure how long each record type is retained. HIPAA requires a minimum of 6 years (2190 days).</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {retentionPolicies?.map((policy) => (
              <div key={policy.recordType} className="flex items-center justify-between py-3 border-b last:border-0">
                <div>
                  <p className="font-medium text-sm">{RETENTION_LABELS[policy.recordType] ?? policy.recordType}</p>
                  <p className="text-xs text-muted-foreground">
                    {policy.retentionDays} days ({Math.round(policy.retentionDays / 365 * 10) / 10} years)
                    {policy.retentionDays < 2190 && <span className="text-yellow-600 ml-1">⚠ Below HIPAA minimum</span>}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Select
                    value={String(policy.retentionDays)}
                    onValueChange={(v) => updateRetentionMut.mutate({ recordType: policy.recordType, retentionDays: parseInt(v), isEnabled: policy.isEnabled })}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1825">5 years</SelectItem>
                      <SelectItem value="2190">6 years (HIPAA min)</SelectItem>
                      <SelectItem value="2555">7 years</SelectItem>
                      <SelectItem value="3650">10 years</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={policy.isEnabled}
                      onCheckedChange={(checked) => updateRetentionMut.mutate({ recordType: policy.recordType, retentionDays: policy.retentionDays, isEnabled: checked })}
                    />
                    <Label className="text-xs text-muted-foreground">Auto-delete</Label>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── BAA & SOC 2 Tab ──────────────────────────────────────────────────────────
const BAA_STATUS_LABEL: Record<BaaStatus, string> = {
  pass: "Pass",
  warn: "Needs review",
  partial: "Partial",
  fail: "Fail",
};

const BAA_STATUS_BADGE: Record<BaaStatus, string> = {
  pass: "bg-green-100 text-green-800",
  warn: "bg-yellow-100 text-yellow-800",
  partial: "bg-yellow-100 text-yellow-800",
  fail: "bg-red-100 text-red-800",
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
      a.download = `soc2-evidence-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      toast({ title: "SOC 2 evidence pack generated and downloaded" });
    } catch {
      toast({ title: "Failed to generate SOC 2 pack", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const statusIcon = (status: BaaStatus) => {
    if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
    if (status === "fail") return <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />;
    return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />;
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Passing</p>
            <p className="text-2xl font-bold text-green-600" data-testid="baa-passing">{passing}/{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Needs attention</p>
            <p className="text-2xl font-bold text-yellow-600" data-testid="baa-attention">{attention}/{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Evidence Pack</p>
                <p className="text-xs text-muted-foreground mt-0.5">For SOC 2 auditors</p>
              </div>
              <Button size="sm" onClick={generatePdf} disabled={generating}>
                {generating ? <RefreshCcw className="h-4 w-4 mr-1.5 animate-spin" /> : <FileText className="h-4 w-4 mr-1.5" />}
                {generating ? "Generating…" : "Generate PDF"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}</div>
      ) : isError ? (
        <p className="text-sm text-muted-foreground">Couldn't load the BAA checklist. Try again in a moment.</p>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">HIPAA BAA readiness</CardTitle>
            {data?.generatedAt && (
              <CardDescription>Checked {new Date(data.generatedAt).toLocaleString()}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {controls.map((control) => (
              <div key={control.id} className="flex items-start gap-3 p-3 rounded-lg border bg-muted/20" data-testid={`baa-control-${control.id}`}>
                {statusIcon(control.status)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{control.label}</p>
                  {control.note && <p className="text-xs text-muted-foreground mt-0.5">{control.note}</p>}
                </div>
                <Badge variant="secondary" className={`text-xs shrink-0 ${BAA_STATUS_BADGE[control.status] ?? ""}`}>
                  {BAA_STATUS_LABEL[control.status] ?? control.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
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
        ? apiFetch<ClerkSession[]>(`/api/admin/users/${expandedUserId}/sessions`)
        : Promise.resolve<ClerkSession[]>([]),
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        View and manage active user sessions. Force logout terminates all active sessions for a user immediately.
      </p>

      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}</div>
      ) : (
        <div className="space-y-2">
          {users?.filter((u) => u.isActive).map((user) => (
            <Card key={user.id} className={expandedUserId === user.id ? "border-blue-200" : ""}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                      {user.fullName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{user.fullName}</p>
                      <p className="text-xs text-muted-foreground">{user.email} · <Badge variant="secondary" className="text-xs">{user.role}</Badge></p>
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
    </div>
  );
}

// ─── Export Log Tab ───────────────────────────────────────────────────────────
function ExportLogTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "export-log"],
    queryFn: () => apiFetch<ExportLogResponse>("/api/admin/export-log?limit=100"),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">All data exports performed by users in your organization are logged here for HIPAA compliance.</p>
      {isLoading ? (
        <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <Card>
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
                  <TableCell><Badge variant="secondary" className="text-xs">{entry.exportType.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell className="text-sm">{entry.recordCount?.toLocaleString() ?? "—"}</TableCell>
                </TableRow>
              ))}
              {data?.exports.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No data exports recorded yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// Types
type AuditEntry = { id: string; createdAt: string; userId: string | null; userFullName: string | null; userRole: string | null; action: string; resourceType: string; resourceId: string | null; ipAddress: string | null; changes?: unknown };
type AuditLogResponse = { entries: AuditEntry[]; total: number; limit: number; offset: number };
type UserRow = { id: string; email: string; fullName: string; role: string; isActive: boolean; lastLoginAt: string | null; createdAt: string };
type LoginEvent = { id: string; email: string | null; userId: string | null; success: boolean; ipAddress: string | null; failureReason: string | null; createdAt: string };
type LoginHistoryResponse = { events: LoginEvent[]; total: number };
type RetentionPolicy = { id: string | null; orgId: string; recordType: string; retentionDays: number; isEnabled: boolean };
type BaaStatus = "pass" | "warn" | "partial" | "fail";
type BaaControl = { id: string; label: string; status: BaaStatus; note?: string; evidenceUrl?: string };
type BaaChecklistResponse = { controls: BaaControl[]; overall: BaaStatus; generatedAt: string };
type ExportEntry = { id: string; userId: string | null; userFullName: string | null; exportType: string; recordCount: number | null; createdAt: string };
type ExportLogResponse = { exports: ExportEntry[]; total: number };
type ClerkSession = { sessionId: string; createdAt: string; lastActiveAt: string; expireAt: string; status: string };

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function AdminCompliancePage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(ADMIN_OR_COMPLIANCE_ROLES);

  if (!meLoading && !isAdmin) {
    return <div className="p-8 text-center text-muted-foreground">You don't have access to this page.</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-blue-600" />
          HIPAA / SOC 2 Compliance
        </h1>
        <p className="text-muted-foreground mt-1">Security controls, access review, audit trails, and evidence management.</p>
      </div>

      <Tabs defaultValue="baa-soc2">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="baa-soc2" className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> BAA / SOC 2
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
    </div>
  );
}
