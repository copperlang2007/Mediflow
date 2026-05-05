import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck, Download, LogIn, FileDown, Lock, Database,
  CheckCircle2, AlertTriangle, Clock, ChevronRight, Users,
  RefreshCcw, FileText,
} from "lucide-react";

// ─── Audit Log Tab ────────────────────────────────────────────────────────────
function AuditLogTab() {
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-log", page],
    queryFn: () => apiFetch<AuditLogResponse>(`/api/admin/audit-log?limit=${limit}&offset=${page * limit}`),
  });

  const handleExport = async () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const res = await fetch(`${base}/api/admin/audit-log/export`, { credentials: "include" });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Complete audit trail of all data access and modifications.</p>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      </div>

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
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.entries.map((entry: AuditEntry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">{entry.userFullName ?? entry.userId ?? "—"}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-xs">{entry.userRole ?? "—"}</Badge></TableCell>
                  <TableCell><Badge variant={entry.action === "delete" ? "destructive" : "outline"} className="text-xs">{entry.action}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId.slice(0, 8)}…` : ""}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.ipAddress ?? "—"}</TableCell>
                </TableRow>
              ))}
              {data?.entries.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No audit log entries found.</TableCell></TableRow>
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
    const res = await fetch(`${base}/api/admin/access-review/export`, { credentials: "include" });
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

  return (
    <div className="space-y-4">
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
function BaaSoc2Tab() {
  const { toast } = useToast();
  const [generating, setGenerating] = useState(false);

  const { data: controls, isLoading } = useQuery({
    queryKey: ["admin", "baa-checklist"],
    queryFn: () => apiFetch<BaaControl[]>("/api/admin/baa-checklist"),
  });

  const implemented = controls?.filter((c) => c.status === "implemented").length ?? 0;
  const partial = controls?.filter((c) => c.status === "partial").length ?? 0;
  const total = controls?.length ?? 0;

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

  const statusIcon = (status: string) => {
    if (status === "implemented") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
    if (status === "partial") return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />;
    return <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />;
  };

  const categories = [...new Set(controls?.map((c) => c.category) ?? [])];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Implemented</p>
            <p className="text-2xl font-bold text-green-600">{implemented}/{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Partial</p>
            <p className="text-2xl font-bold text-yellow-600">{partial}/{total}</p>
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
      ) : (
        <div className="space-y-6">
          {categories.map((category) => (
            <Card key={category}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{category}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {controls?.filter((c) => c.category === category).map((control) => (
                  <div key={control.id} className="flex items-start gap-3 p-3 rounded-lg border bg-muted/20">
                    {statusIcon(control.status)}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{control.control}</p>
                      {control.notes && <p className="text-xs text-muted-foreground mt-0.5">{control.notes}</p>}
                    </div>
                    <Badge
                      variant={control.status === "implemented" ? "default" : "secondary"}
                      className={`text-xs shrink-0 ${control.status === "implemented" ? "bg-green-100 text-green-800" : control.status === "partial" ? "bg-yellow-100 text-yellow-800" : ""}`}
                    >
                      {control.status === "implemented" ? "Implemented" : control.status === "partial" ? "Partial" : "Not Implemented"}
                    </Badge>
                  </div>
                ))}
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
type AuditEntry = { id: string; createdAt: string; userId: string | null; userFullName: string | null; userRole: string | null; action: string; resourceType: string; resourceId: string | null; ipAddress: string | null };
type AuditLogResponse = { entries: AuditEntry[]; total: number; limit: number; offset: number };
type UserRow = { id: string; email: string; fullName: string; role: string; isActive: boolean; lastLoginAt: string | null; createdAt: string };
type LoginEvent = { id: string; email: string | null; userId: string | null; success: boolean; ipAddress: string | null; failureReason: string | null; createdAt: string };
type LoginHistoryResponse = { events: LoginEvent[]; total: number };
type RetentionPolicy = { id: string | null; orgId: string; recordType: string; retentionDays: number; isEnabled: boolean };
type BaaControl = { id: string; category: string; control: string; status: string; notes?: string };
type ExportEntry = { id: string; userId: string | null; userFullName: string | null; exportType: string; recordCount: number | null; createdAt: string };
type ExportLogResponse = { exports: ExportEntry[]; total: number };

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function AdminCompliancePage() {
  const { data: me } = useGetMe();

  if (me && !["super_admin", "agency_admin", "compliance_manager"].includes(me.role)) {
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
          <TabsContent value="access-review"><AccessReviewTab /></TabsContent>
          <TabsContent value="login-history"><LoginHistoryTab /></TabsContent>
          <TabsContent value="export-log"><ExportLogTab /></TabsContent>
          <TabsContent value="security-config"><SecurityConfigTab /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
