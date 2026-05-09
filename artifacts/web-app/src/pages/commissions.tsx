import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  useGetCarriers,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  DollarSign,
  Upload,
  Plus,
  Inbox,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — local mirror of #39's response shapes (until codegen reruns).
// ---------------------------------------------------------------------------

type StatementStatus = "pending" | "parsed" | "reconciled" | "disputed";

type CommissionStatement = {
  id: string;
  orgId: string;
  carrierId: string;
  carrierName?: string | null;
  periodStart: string;
  periodEnd: string;
  statementDate?: string | null;
  totalAmount: number | string;
  status: StatementStatus;
  lineItemCount?: number | null;
  matchedCount?: number | null;
  unmatchedCount?: number | null;
  uploadedAt?: string | null;
  createdAt?: string | null;
};

type CommissionSchedule = {
  id: string;
  carrierId: string;
  carrierName?: string | null;
  planType: string;
  year: number;
  initialPercent?: number | null;
  renewalPercent?: number | null;
  flatAmount?: number | null;
};

type CommissionHierarchy = {
  id: string;
  writingAgentId: string;
  writingAgentName?: string | null;
  uplineAgentId: string;
  uplineAgentName?: string | null;
  splitPercent: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

type MissedPayment = {
  id: string;
  contactId?: string | null;
  contactName?: string | null;
  policyNumber?: string | null;
  expectedAmount: number | string;
  expectedPeriodStart?: string | null;
  expectedPeriodEnd?: string | null;
  daysOverdue: number;
};

type StatementsListResponse =
  | CommissionStatement[]
  | { data: CommissionStatement[] };

type SchedulesListResponse =
  | CommissionSchedule[]
  | { data: CommissionSchedule[] };

type HierarchiesListResponse =
  | CommissionHierarchy[]
  | { data: CommissionHierarchy[] };

type MissedPaymentsResponse =
  | MissedPayment[]
  | { data: MissedPayment[] };

function unwrap<T>(resp: T[] | { data: T[] } | undefined | null): T[] {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  return resp.data ?? [];
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const fmtMoney = (val: number | string | null | undefined): string => {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (Number.isNaN(n)) return "—";
  return usd.format(n);
};

const fmtDate = (d: string | null | undefined): string =>
  d ? format(new Date(d), "MMM d, yyyy") : "—";

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  helper,
  icon: Icon,
}: {
  label: string;
  value: string;
  helper?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-4 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            {label}
          </p>
          {Icon && <Icon className="h-4 w-4 text-muted-foreground/60" />}
        </div>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
      </CardContent>
    </Card>
  );
}

const STATUS_STYLES: Record<StatementStatus, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  parsed: "bg-blue-100 text-blue-800 border-blue-200",
  reconciled: "bg-green-100 text-green-800 border-green-200",
  disputed: "bg-red-100 text-red-800 border-red-200",
};

// ---------------------------------------------------------------------------
// Upload dialog (also used from elsewhere)
// ---------------------------------------------------------------------------

export function UploadStatementDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: (statement: CommissionStatement) => void;
}) {
  const { data: carriers } = useGetCarriers();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [carrierId, setCarrierId] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const reset = () => {
    setCarrierId("");
    setStatementDate("");
    setPeriodStart("");
    setPeriodEnd("");
    setTotalAmount("");
    setFile(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!carrierId || !periodStart || !periodEnd || !totalAmount || !file) {
      toast.error("All fields are required");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("carrierId", carrierId);
      fd.append("statementDate", statementDate || periodEnd);
      fd.append("periodStart", periodStart);
      fd.append("periodEnd", periodEnd);
      fd.append("totalAmount", totalAmount);
      fd.append("file", file);

      const created = await customFetch<CommissionStatement>(
        "/api/commissions/statements",
        { method: "POST", body: fd },
      );

      // Auto-trigger parse — non-fatal if it fails (user can retry from row).
      try {
        await customFetch(`/api/commissions/statements/${created.id}/parse`, {
          method: "POST",
        });
      } catch {
        toast.message("Statement uploaded, but parse failed — retry from the list");
      }

      toast.success("Statement uploaded");
      void qc.invalidateQueries({ queryKey: ["/api/commissions/statements"] });
      onUploaded?.(created);
      onOpenChange(false);
      reset();
      if (created.id) navigate(`/commissions/statements/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload commission statement</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Carrier *</Label>
            <Select value={carrierId} onValueChange={setCarrierId}>
              <SelectTrigger><SelectValue placeholder="Select carrier" /></SelectTrigger>
              <SelectContent>
                {(carriers ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Period start *</Label>
              <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Period end *</Label>
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Statement date</Label>
              <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Total amount *</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Statement file *</Label>
            <Input
              type="file"
              accept=".pdf,.csv,.xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
              Cancel
            </Button>
            <Button type="submit" disabled={uploading || !carrierId || !file}>
              {uploading ? (<><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading…</>) : "Upload & parse"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pagination helper (matches /contacts client-side pattern)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

function usePaged<T>(rows: T[]) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = useMemo(
    () => rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [rows, safePage],
  );
  return { slice, page: safePage, totalPages, setPage };
}

function PaginationBar({
  page,
  totalPages,
  setPage,
  total,
}: {
  page: number;
  totalPages: number;
  setPage: (p: number) => void;
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
      <span>{total} total</span>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm" variant="outline" className="h-7 px-2"
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="tabular-nums">Page {page} of {totalPages}</span>
        <Button
          size="sm" variant="outline" className="h-7 px-2"
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statements tab
// ---------------------------------------------------------------------------

function StatementsTab({ onUpload }: { onUpload: () => void }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const queryParams =
    statusFilter === "all"
      ? ""
      : `?status=${encodeURIComponent(statusFilter)}`;

  const { data, isLoading } = useQuery<StatementsListResponse>({
    queryKey: ["/api/commissions/statements", { status: statusFilter }],
    queryFn: () =>
      customFetch<StatementsListResponse>(
        `/api/commissions/statements${queryParams}`,
      ),
    staleTime: 30_000,
  });

  const rows = unwrap(data);
  const { slice, page, totalPages, setPage } = usePaged(rows);

  const parse = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/commissions/statements/${id}/parse`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Parse queued");
      void qc.invalidateQueries({ queryKey: ["/api/commissions/statements"] });
    },
    onError: () => toast.error("Parse failed"),
  });

  const reconcile = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/commissions/statements/${id}/reconcile`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Reconcile started");
      void qc.invalidateQueries({ queryKey: ["/api/commissions/statements"] });
    },
    onError: () => toast.error("Reconcile failed"),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-44 h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="parsed">Parsed</SelectItem>
            <SelectItem value="reconciled">Reconciled</SelectItem>
            <SelectItem value="disputed">Disputed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Inbox className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No statements yet</p>
          <p className="text-xs mt-1">Upload your first commission statement to get started</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={onUpload}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Upload statement
          </Button>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/commissions/statements/${s.id}`)}
                  >
                    <TableCell className="font-medium">{s.carrierName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {fmtMoney(s.totalAmount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={cn("capitalize border", STATUS_STYLES[s.status])}>
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {fmtDate(s.uploadedAt ?? s.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm" variant="ghost" className="h-7 px-2 text-xs"
                          onClick={() => navigate(`/commissions/statements/${s.id}`)}
                        >
                          View
                        </Button>
                        {s.status === "pending" && (
                          <Button
                            size="sm" variant="outline" className="h-7 px-2 text-xs"
                            disabled={parse.isPending}
                            onClick={() => parse.mutate(s.id)}
                          >
                            Parse
                          </Button>
                        )}
                        {s.status === "parsed" && (
                          <Button
                            size="sm" variant="outline" className="h-7 px-2 text-xs"
                            disabled={reconcile.isPending}
                            onClick={() => reconcile.mutate(s.id)}
                          >
                            Reconcile
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} totalPages={totalPages} setPage={setPage} total={rows.length} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedules tab — rate cards by carrier × planType × year
// ---------------------------------------------------------------------------

function SchedulesTab() {
  const qc = useQueryClient();
  const { data: carriers } = useGetCarriers();
  const [yearFilter, setYearFilter] = useState<string>(String(new Date().getFullYear()));
  const [carrierFilter, setCarrierFilter] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);

  const params: string[] = [];
  if (carrierFilter !== "all") params.push(`carrierId=${encodeURIComponent(carrierFilter)}`);
  if (yearFilter) params.push(`year=${encodeURIComponent(yearFilter)}`);
  const qs = params.length ? `?${params.join("&")}` : "";

  const { data, isLoading } = useQuery<SchedulesListResponse>({
    queryKey: ["/api/commission-schedules", { carrierId: carrierFilter, year: yearFilter }],
    queryFn: () => customFetch<SchedulesListResponse>(`/api/commission-schedules${qs}`),
    staleTime: 60_000,
  });
  const rows = unwrap(data);
  const { slice, page, totalPages, setPage } = usePaged(rows);

  const [form, setForm] = useState({
    carrierId: "",
    planType: "MAPD",
    year: String(new Date().getFullYear()),
    initialPercent: "",
    renewalPercent: "",
    flatAmount: "",
  });

  const create = useMutation({
    mutationFn: () =>
      customFetch("/api/commission-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          carrierId: form.carrierId,
          planType: form.planType,
          year: parseInt(form.year, 10),
          initialPercent: form.initialPercent ? parseFloat(form.initialPercent) : undefined,
          renewalPercent: form.renewalPercent ? parseFloat(form.renewalPercent) : undefined,
          flatAmount: form.flatAmount ? parseFloat(form.flatAmount) : undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Schedule added");
      void qc.invalidateQueries({ queryKey: ["/api/commission-schedules"] });
      setAddOpen(false);
      setForm({ carrierId: "", planType: "MAPD", year: String(new Date().getFullYear()), initialPercent: "", renewalPercent: "", flatAmount: "" });
    },
    onError: () => toast.error("Failed to create schedule"),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={carrierFilter} onValueChange={(v) => { setCarrierFilter(v); setPage(1); }}>
          <SelectTrigger className="w-48 h-9"><SelectValue placeholder="Carrier" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All carriers</SelectItem>
            {(carriers ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          className="w-28 h-9"
          value={yearFilter}
          onChange={(e) => { setYearFilter(e.target.value); setPage(1); }}
          placeholder="Year"
        />
        <div className="flex-1" />
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New schedule
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <DollarSign className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No commission schedules</p>
          <p className="text-xs mt-1">Add a rate card to start tracking expected commissions</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Plan type</TableHead>
                  <TableHead>Year</TableHead>
                  <TableHead className="text-right">Initial %</TableHead>
                  <TableHead className="text-right">Renewal %</TableHead>
                  <TableHead className="text-right">Flat $</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.carrierName ?? "—"}</TableCell>
                    <TableCell>{s.planType}</TableCell>
                    <TableCell className="tabular-nums">{s.year}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.initialPercent != null ? `${s.initialPercent}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.renewalPercent != null ? `${s.renewalPercent}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.flatAmount != null ? fmtMoney(s.flatAmount) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} totalPages={totalPages} setPage={setPage} total={rows.length} />
        </>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New commission schedule</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Carrier *</Label>
              <Select value={form.carrierId} onValueChange={(v) => setForm((p) => ({ ...p, carrierId: v }))}>
                <SelectTrigger><SelectValue placeholder="Select carrier" /></SelectTrigger>
                <SelectContent>
                  {(carriers ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Plan type *</Label>
                <Select value={form.planType} onValueChange={(v) => setForm((p) => ({ ...p, planType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["MAPD", "PDP", "MEDSUPP", "DSNP", "ANCILLARY"].map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Year *</Label>
                <Input type="number" value={form.year} onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))} required />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Initial %</Label>
                <Input type="number" step="0.01" value={form.initialPercent} onChange={(e) => setForm((p) => ({ ...p, initialPercent: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Renewal %</Label>
                <Input type="number" step="0.01" value={form.renewalPercent} onChange={(e) => setForm((p) => ({ ...p, renewalPercent: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Flat $</Label>
                <Input type="number" step="0.01" value={form.flatAmount} onChange={(e) => setForm((p) => ({ ...p, flatAmount: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || !form.carrierId}>
                {create.isPending ? "Saving…" : "Save schedule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hierarchies tab — split editor
// ---------------------------------------------------------------------------

function HierarchiesTab() {
  const qc = useQueryClient();
  const [agentFilter, setAgentFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const qs = agentFilter ? `?agentId=${encodeURIComponent(agentFilter)}` : "";

  const { data, isLoading } = useQuery<HierarchiesListResponse>({
    queryKey: ["/api/commission-hierarchies", { agentId: agentFilter || null }],
    queryFn: () => customFetch<HierarchiesListResponse>(`/api/commission-hierarchies${qs}`),
    staleTime: 60_000,
  });
  const rows = unwrap(data);
  const { slice, page, totalPages, setPage } = usePaged(rows);

  const [form, setForm] = useState({
    writingAgentId: "",
    uplineAgentId: "",
    splitPercent: "",
    effectiveFrom: "",
    effectiveTo: "",
  });

  const create = useMutation({
    mutationFn: () =>
      customFetch("/api/commission-hierarchies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          writingAgentId: form.writingAgentId,
          uplineAgentId: form.uplineAgentId,
          splitPercent: parseFloat(form.splitPercent),
          effectiveFrom: form.effectiveFrom || undefined,
          effectiveTo: form.effectiveTo || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Hierarchy split added");
      void qc.invalidateQueries({ queryKey: ["/api/commission-hierarchies"] });
      setAddOpen(false);
      setForm({ writingAgentId: "", uplineAgentId: "", splitPercent: "", effectiveFrom: "", effectiveTo: "" });
    },
    onError: () => toast.error("Failed to create hierarchy"),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter by agent ID"
          className="w-64 h-9"
          value={agentFilter}
          onChange={(e) => { setAgentFilter(e.target.value); setPage(1); }}
        />
        <div className="flex-1" />
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New hierarchy
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <DollarSign className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No commission hierarchies</p>
          <p className="text-xs mt-1">Add an upline split to begin tracking overrides</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Writing agent</TableHead>
                  <TableHead>Upline agent</TableHead>
                  <TableHead className="text-right">Split %</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Effective to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-medium">
                      {h.writingAgentName ?? h.writingAgentId.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      {h.uplineAgentName ?? h.uplineAgentId.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{h.splitPercent}%</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{fmtDate(h.effectiveFrom)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{fmtDate(h.effectiveTo)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} totalPages={totalPages} setPage={setPage} total={rows.length} />
        </>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New commission hierarchy</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Writing agent ID *</Label>
              <Input value={form.writingAgentId} onChange={(e) => setForm((p) => ({ ...p, writingAgentId: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>Upline agent ID *</Label>
              <Input value={form.uplineAgentId} onChange={(e) => setForm((p) => ({ ...p, uplineAgentId: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>Split % *</Label>
              <Input type="number" step="0.01" value={form.splitPercent} onChange={(e) => setForm((p) => ({ ...p, splitPercent: e.target.value }))} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Effective from</Label>
                <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm((p) => ({ ...p, effectiveFrom: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Effective to</Label>
                <Input type="date" value={form.effectiveTo} onChange={(e) => setForm((p) => ({ ...p, effectiveTo: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || !form.writingAgentId || !form.uplineAgentId || !form.splitPercent}>
                {create.isPending ? "Saving…" : "Save hierarchy"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missed payments tab
// ---------------------------------------------------------------------------

function MissedPaymentsTab() {
  const qc = useQueryClient();
  const [daysFilter, setDaysFilter] = useState<string>("0");
  const [resolveFor, setResolveFor] = useState<MissedPayment | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const qs = parseInt(daysFilter, 10) > 0 ? `?days_overdue=${daysFilter}` : "";

  const { data, isLoading } = useQuery<MissedPaymentsResponse>({
    queryKey: ["/api/commissions/missed-payments", { daysOverdue: daysFilter }],
    queryFn: () => customFetch<MissedPaymentsResponse>(`/api/commissions/missed-payments${qs}`),
    staleTime: 30_000,
  });
  const rows = unwrap(data);
  const { slice, page, totalPages, setPage } = usePaged(rows);

  const resolve = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      customFetch(`/api/commissions/missed-payments/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      }),
    onSuccess: () => {
      toast.success("Missed payment resolved");
      void qc.invalidateQueries({ queryKey: ["/api/commissions/missed-payments"] });
      setResolveFor(null);
      setResolveNote("");
    },
    onError: () => toast.error("Failed to resolve"),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs text-muted-foreground">Days overdue ≥</Label>
        <Input
          type="number"
          min="0"
          className="w-24 h-9"
          value={daysFilter}
          onChange={(e) => { setDaysFilter(e.target.value); setPage(1); }}
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <AlertTriangle className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No missed payments</p>
          <p className="text-xs mt-1">All expected commissions are accounted for</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Policy #</TableHead>
                  <TableHead className="text-right">Expected $</TableHead>
                  <TableHead>Expected period</TableHead>
                  <TableHead className="text-right">Days overdue</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.map((mp) => (
                  <TableRow key={mp.id}>
                    <TableCell className="font-medium">{mp.contactName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm font-mono">
                      {mp.policyNumber ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {fmtMoney(mp.expectedAmount)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {fmtDate(mp.expectedPeriodStart)} – {fmtDate(mp.expectedPeriodEnd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={cn("font-semibold", mp.daysOverdue >= 60 ? "text-red-600" : mp.daysOverdue >= 30 ? "text-amber-600" : "text-foreground")}>
                        {mp.daysOverdue}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setResolveFor(mp)}>
                        Mark resolved
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} totalPages={totalPages} setPage={setPage} total={rows.length} />
        </>
      )}

      <Dialog open={!!resolveFor} onOpenChange={(v) => !v && setResolveFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Resolve missed payment</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {resolveFor && (
              <p className="text-xs text-muted-foreground">
                {resolveFor.contactName ?? "—"} · {fmtMoney(resolveFor.expectedAmount)}
              </p>
            )}
            <div className="space-y-1.5">
              <Label>Resolution note</Label>
              <Textarea
                rows={3}
                placeholder="Carrier confirmed payment will arrive next cycle…"
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveFor(null)}>Cancel</Button>
            <Button
              disabled={resolve.isPending || !resolveFor}
              onClick={() => resolveFor && resolve.mutate({ id: resolveFor.id, note: resolveNote })}
            >
              {resolve.isPending ? "Saving…" : "Mark resolved"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI summary
// ---------------------------------------------------------------------------

type CommissionsSummary = {
  earnedThisPeriod?: number | string;
  paidThisPeriod?: number | string;
  pendingThisPeriod?: number | string;
  missedPaymentsCount?: number;
  agentsOnPayouts?: number;
  periodLabel?: string;
};

function KpiRow() {
  const { data, isLoading } = useQuery<CommissionsSummary>({
    queryKey: ["/api/commissions/summary"],
    queryFn: () => customFetch<CommissionsSummary>("/api/commissions/summary"),
    staleTime: 60_000,
    // Backend may not expose summary endpoint yet — fall back gracefully.
    retry: false,
  });

  const items = [
    { label: "Earned (period)", value: fmtMoney(data?.earnedThisPeriod), helper: data?.periodLabel },
    { label: "Paid (period)", value: fmtMoney(data?.paidThisPeriod) },
    { label: "Pending (period)", value: fmtMoney(data?.pendingThisPeriod) },
    { label: "Missed payments", value: data?.missedPaymentsCount != null ? String(data.missedPaymentsCount) : "—" },
    { label: "Agents on payouts", value: data?.agentsOnPayouts != null ? String(data.agentsOnPayouts) : "—" },
  ];

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {items.map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {items.map((it) => (
        <StatCard key={it.label} label={it.label} value={it.value} helper={it.helper} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CommissionsPage() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tab, setTab] = useState<"statements" | "schedules" | "hierarchies" | "missed">("statements");

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Commissions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Statements, rate cards, hierarchy splits, and reconciliation.
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="h-4 w-4 mr-1.5" />
          Upload statement
        </Button>
      </div>

      <KpiRow />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="space-y-4">
        <TabsList className="bg-muted/60 h-9">
          <TabsTrigger value="statements">Statements</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="hierarchies">Hierarchies</TabsTrigger>
          <TabsTrigger value="missed">Missed payments</TabsTrigger>
        </TabsList>
        <TabsContent value="statements" className="mt-4">
          <StatementsTab onUpload={() => setUploadOpen(true)} />
        </TabsContent>
        <TabsContent value="schedules" className="mt-4">
          <SchedulesTab />
        </TabsContent>
        <TabsContent value="hierarchies" className="mt-4">
          <HierarchiesTab />
        </TabsContent>
        <TabsContent value="missed" className="mt-4">
          <MissedPaymentsTab />
        </TabsContent>
      </Tabs>

      <UploadStatementDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}
