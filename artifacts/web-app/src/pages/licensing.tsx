import { useState, useRef } from "react";
import { useGetAgents, useGetAgentLicenses, useGetRenewals, useBulkImportLicenses } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { FileText, AlertTriangle, Clock, CheckCircle, Search, Upload, CheckCircle2, XCircle } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { toast } from "sonner";

const LICENSE_STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  pending: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
  suspended: "bg-red-100 text-red-800",
  not_appointed: "bg-slate-100 text-slate-600",
};

const URGENCY_STYLES: Record<string, { badge: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  critical: { badge: "bg-red-100 text-red-800 border-red-200", icon: AlertTriangle, label: "≤30 days" },
  warning: { badge: "bg-amber-100 text-amber-800 border-amber-200", icon: Clock, label: "31–60 days" },
  notice: { badge: "bg-blue-100 text-blue-800 border-blue-200", icon: Clock, label: "61–90 days" },
};

// CSV Import Dialog
function CsvImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [parsing, setParsing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { mutateAsync: bulkImport, isPending } = useBulkImportLicenses();

  const handleClose = () => {
    setFile(null);
    setResult(null);
    onClose();
  };

  const parseCsv = (text: string): Record<string, string>[] => {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").trim());
    return lines.slice(1).map((line) => {
      const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, "").trim());
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
    });
  };

  const handleImport = async () => {
    if (!file) return;
    setParsing(true);
    try {
      const text = await file.text();
      const rows = parseCsv(text).filter((r) => r.agentId && r.stateCode && r.licenseType);
      if (rows.length === 0) {
        toast.error("No valid rows found in CSV");
        setParsing(false);
        return;
      }
      const res = await bulkImport({ data: { rows: rows as Parameters<typeof bulkImport>[0]["data"]["rows"] } });
      setResult(res);
      if (res.imported > 0) toast.success(`Imported ${res.imported} license${res.imported !== 1 ? "s" : ""}`);
      else toast.error("No licenses imported");
    } catch {
      toast.error("Import failed");
    } finally {
      setParsing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Licenses from CSV</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {!result ? (
            <>
              <div className="rounded-lg border-2 border-dashed border-border p-6 text-center">
                <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                <p className="text-sm font-medium mb-1">Upload a CSV file</p>
                <p className="text-xs text-muted-foreground mb-3">Required columns: agentId, stateCode, licenseType</p>
                <p className="text-xs text-muted-foreground mb-3">Optional: licenseNumber, issueDate, expiryDate, status</p>
                {file ? (
                  <div className="flex items-center justify-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-primary" />
                    <span className="font-medium text-primary">{file.name}</span>
                    <button className="text-muted-foreground hover:text-destructive text-xs underline" onClick={() => setFile(null)}>Remove</button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                    Choose File
                  </Button>
                )}
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border p-3 flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  <div>
                    <p className="text-xl font-bold text-green-700">{result.imported}</p>
                    <p className="text-xs text-muted-foreground">Imported</p>
                  </div>
                </div>
                <div className="rounded-lg border p-3 flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-amber-500 shrink-0" />
                  <div>
                    <p className="text-xl font-bold text-amber-600">{result.skipped}</p>
                    <p className="text-xs text-muted-foreground">Skipped</p>
                  </div>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div className="rounded-lg bg-destructive/5 border border-destructive/20 p-3 max-h-32 overflow-y-auto space-y-1">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-destructive">{e}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose}>{result ? "Close" : "Cancel"}</Button>
          {!result && (
            <Button disabled={!file || isPending || parsing} onClick={handleImport}>
              {isPending || parsing ? "Importing…" : "Import"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LicensingPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [importOpen, setImportOpen] = useState(false);
  const [, navigate] = useLocation();

  const { data: renewals, isLoading: renewalsLoading } = useGetRenewals({ days: 90 });
  const licenseRenewals = renewals?.renewals.filter((r) => r.type === "license") ?? [];

  const { data: agentData, isLoading: agentsLoading } = useGetAgents({ limit: 200 });
  const agents = agentData?.agents ?? [];

  const filteredAgents = agents.filter((a) => {
    if (statusFilter !== "all" && a.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        a.firstName.toLowerCase().includes(q) ||
        a.lastName.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Licensing</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Track and manage state licenses across all agents</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Import CSV
        </Button>
      </div>
      <CsvImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <div className="grid grid-cols-3 gap-4">
        {renewalsLoading ? (
          [...Array(3)].map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-red-100 flex items-center justify-center">
                    <AlertTriangle className="h-5 w-5 text-red-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{licenseRenewals.filter((r) => r.urgency === "critical").length}</p>
                    <p className="text-xs text-muted-foreground">Expiring in ≤30 days</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-amber-100 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{licenseRenewals.filter((r) => r.urgency === "warning").length}</p>
                    <p className="text-xs text-muted-foreground">Expiring in 31–60 days</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{licenseRenewals.filter((r) => r.urgency === "notice").length}</p>
                    <p className="text-xs text-muted-foreground">Expiring in 61–90 days</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {licenseRenewals.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Upcoming Renewals
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {licenseRenewals.slice(0, 10).map((r) => {
                const config = URGENCY_STYLES[r.urgency];
                const Icon = config?.icon ?? Clock;
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                    onClick={() => navigate(`/agents/${r.agentId}`)}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", r.urgency === "critical" ? "text-red-500" : r.urgency === "warning" ? "text-amber-500" : "text-blue-500")} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{r.agentName}</p>
                      <p className="text-xs text-muted-foreground">{r.detail}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-medium">{format(new Date(r.expiryDate), "MMM d, yyyy")}</p>
                      <p className={cn("text-xs", r.urgency === "critical" ? "text-red-600" : r.urgency === "warning" ? "text-amber-600" : "text-blue-600")}>
                        {r.daysUntilExpiry}d left
                      </p>
                    </div>
                    <Badge variant="secondary" className={cn("text-xs border", config?.badge)}>
                      {config?.label}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Agent Licenses</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex gap-3 mb-4 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agents…"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {agentsLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <p className="text-sm">No agents found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredAgents.map((agent) => (
                <AgentLicenseRow
                  key={agent.id}
                  agentId={agent.id}
                  agentName={`${agent.firstName} ${agent.lastName}`}
                  agentEmail={agent.email}
                  onNavigate={() => navigate(`/agents/${agent.id}?tab=licenses`)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AgentLicenseRow({
  agentId,
  agentName,
  agentEmail,
  onNavigate,
}: {
  agentId: string;
  agentName: string;
  agentEmail: string;
  onNavigate: () => void;
}) {
  const { data: licenses } = useGetAgentLicenses(agentId);
  const activeLicenses = (licenses ?? []).filter((l) => l.status === "active").length;
  const totalLicenses = (licenses ?? []).length;

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
      onClick={onNavigate}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{agentName}</p>
        <p className="text-xs text-muted-foreground">{agentEmail}</p>
      </div>
      {licenses === undefined ? (
        <Skeleton className="h-4 w-20" />
      ) : (
        <div className="flex items-center gap-2">
          {totalLicenses === 0 ? (
            <span className="text-xs text-muted-foreground">No licenses</span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">{activeLicenses}/{totalLicenses} active</span>
              <div className="flex gap-1 flex-wrap max-w-xs">
                {(licenses ?? []).slice(0, 5).map((lic) => (
                  <span
                    key={lic.id}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded font-medium",
                      LICENSE_STATUS_STYLES[lic.status] ?? "bg-slate-100 text-slate-600"
                    )}
                  >
                    {lic.stateCode}
                  </span>
                ))}
                {(licenses ?? []).length > 5 && (
                  <span className="text-[10px] text-muted-foreground">+{licenses!.length - 5}</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
