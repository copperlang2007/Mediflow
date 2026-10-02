import { useState, useMemo, useRef } from "react";
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
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState, AgentPicker, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame, FilterBar } from "@/components/ops";
import { CheckCircle2, Wallet, Clock, Users, Network, FileSpreadsheet } from "lucide-react";
import { useProductName } from "@/lib/branding/BrandingProvider";

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
  /** Shared derivation from the API: reconciled + variance ⇒ "reconciled_with_variance". */
  displayStatus?: StatementStatus | "reconciled_with_variance";
  variance?: number | null;
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
  // Column names as the API returns them; numeric columns arrive as strings.
  contractYear: number;
  initialPct?: string | number | null;
  renewalPct?: string | number | null;
  flatAmount?: string | number | null;
  effectiveFrom?: string | null;
};

const SCHEDULE_PLAN_TYPES: { value: string; label: string }[] = [
  { value: "MAPD", label: "MA + drug (MAPD)" },
  { value: "MA", label: "Medicare Advantage (MA)" },
  { value: "PDP", label: "Drug plan (PDP)" },
  { value: "supp", label: "Medicare Supplement" },
  { value: "other", label: "Other" },
];

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

const STATUS_TONES: Record<StatementStatus | "reconciled_with_variance", StatusTone> = {
  pending: "warning",
  parsed: "info",
  reconciled: "success",
  reconciled_with_variance: "warning",
  disputed: "danger",
};

const STATUS_HINTS: Record<StatementStatus | "reconciled_with_variance", string> = {
  pending: "Uploaded — waiting to be read",
  parsed: "Read — ready to reconcile",
  reconciled: "Matched and paid out",
  reconciled_with_variance: "Matched, but the lines don't add up to the carrier's total — needs review",
  disputed: "Flagged for follow-up",
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
      fd.append("parse", "true");
      fd.append("file", file);

      // The server reads the file during the upload (it doesn't keep the file,
      // so it can't be read later without sending it again).
      const created = await customFetch<CommissionStatement & { parse?: { inserted?: number; error?: string } }>(
        "/api/commissions/statements",
        { method: "POST", body: fd },
      );

      if (created.parse?.error) {
        toast.message(`Statement uploaded, but it couldn't be read: ${created.parse.error} Use Parse on the list to try again with the file.`);
      } else {
        toast.success(`Statement uploaded — ${created.parse?.inserted ?? 0} lines read`);
      }
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
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <p className="text-xs text-muted-foreground">
              CSV files only for now — PDF and Excel statements can't be read yet.
            </p>
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
  const productName = useProductName();
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

  // The server doesn't keep uploaded files, so reading a pending statement
  // means choosing the file again.
  const parseFileInput = useRef<HTMLInputElement>(null);
  const [parseTarget, setParseTarget] = useState<string | null>(null);
  const parse = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append("file", file);
      return customFetch<{ inserted: number }>(`/api/commissions/statements/${id}/parse`, { method: "POST", body: fd });
    },
    onSuccess: (res) => {
      toast.success(`Statement read — ${res.inserted} lines`);
      void qc.invalidateQueries({ queryKey: ["/api/commissions/statements"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't read that file"),
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
    <SectionCard
      title="Carrier statements"
      description="Each statement a carrier sends you, from upload through reconciliation"
      icon={FileSpreadsheet}
    >
      <FilterBar>
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
      </FilterBar>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={statusFilter === "all" ? "No statements yet" : "No statements with this status"}
          description={
            statusFilter === "all"
              ? `Upload a carrier commission statement and ${productName} will read it, match each line to a client and agent, and work out payouts.`
              : "Try another status, or show all statements."
          }
          action={statusFilter === "all" ? { label: "Upload statement", onClick: onUpload } : { label: "Show all", onClick: () => setStatusFilter("all") }}
        />
      ) : (
        <>
          <TableFrame>
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
                    <TableCell className="text-right tabular-nums font-semibold text-success">
                      {fmtMoney(s.totalAmount)}
                    </TableCell>
                    <TableCell>
                      <span title={STATUS_HINTS[s.displayStatus ?? s.status]}>
                        <StatusPill status={s.displayStatus ?? s.status} tone={STATUS_TONES[s.displayStatus ?? s.status]} />
                      </span>
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
                            onClick={() => { setParseTarget(s.id); parseFileInput.current?.click(); }}
                          >
                            Parse (choose file)
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
          </TableFrame>
          <input
            ref={parseFileInput}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            aria-label="Choose the statement file to read"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f && parseTarget) parse.mutate({ id: parseTarget, file: f });
            }}
          />
          <PaginationBar page={page} totalPages={totalPages} setPage={setPage} total={rows.length} />
        </>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Schedules tab — rate cards by carrier × planType × year
// ---------------------------------------------------------------------------

function SchedulesTab() {
  const productName = useProductName();
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
    effectiveFrom: `${new Date().getFullYear()}-01-01`,
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
          contractYear: parseInt(form.year, 10),
          effectiveFrom: form.effectiveFrom,
          initialPct: form.initialPercent ? parseFloat(form.initialPercent) : undefined,
          renewalPct: form.renewalPercent ? parseFloat(form.renewalPercent) : undefined,
          flatAmount: form.flatAmount ? parseFloat(form.flatAmount) : undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Schedule added");
      void qc.invalidateQueries({ queryKey: ["/api/commission-schedules"] });
      setAddOpen(false);
      setForm({ carrierId: "", planType: "MAPD", year: String(new Date().getFullYear()), effectiveFrom: `${new Date().getFullYear()}-01-01`, initialPercent: "", renewalPercent: "", flatAmount: "" });
    },
    onError: () => toast.error("Failed to create schedule"),
  });

  return (
    <SectionCard
      title="Rate cards"
      description="What each carrier pays per plan type and year — used to spot missing payments"
      icon={DollarSign}
    >
      <FilterBar>
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
      </FilterBar>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={DollarSign}
          title="No rate cards for this filter"
          description={`Add a carrier's rate card so ${productName} knows what to expect each month and can flag a payment that never arrives.`}
          action={{ label: "New schedule", onClick: () => setAddOpen(true) }}
        />
      ) : (
        <>
          <TableFrame>
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
                    <TableCell className="tabular-nums">{s.contractYear}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.initialPct != null ? `${Number(s.initialPct)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.renewalPct != null ? `${Number(s.renewalPct)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.flatAmount != null ? fmtMoney(Number(s.flatAmount)) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
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
                    {SCHEDULE_PLAN_TYPES.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Year *</Label>
                <Input type="number" value={form.year} onChange={(e) => setForm((p) => ({ ...p, year: e.target.value, effectiveFrom: `${e.target.value}-01-01` }))} required />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Rates start on *</Label>
              <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm((p) => ({ ...p, effectiveFrom: e.target.value }))} required />
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
    </SectionCard>
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
    <SectionCard
      title="Upline splits"
      description="Who earns an override on whose sales, and for how long"
      icon={Network}
    >
      <FilterBar>
        <AgentPicker
          aria-label="Filter by agent"
          className="w-full sm:w-64"
          triggerClassName="h-9 text-sm"
          value={agentFilter}
          onChange={(v) => { setAgentFilter(v); setPage(1); }}
          noneLabel="All agents"
        />
        <div className="flex-1" />
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New hierarchy
        </Button>
      </FilterBar>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No upline splits yet"
          description="If a manager earns a share of an agent's commission, add the split here and payouts will include it automatically."
          action={{ label: "New hierarchy", onClick: () => setAddOpen(true) }}
        />
      ) : (
        <>
          <TableFrame>
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
          </TableFrame>
          <PaginationBar page={page} totalPages={totalPages} setPage={setPage} total={rows.length} />
        </>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New commission hierarchy</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Writing agent *</Label>
              <AgentPicker
                aria-label="Writing agent"
                triggerClassName="h-9 text-sm"
                value={form.writingAgentId}
                onChange={(v) => setForm((p) => ({ ...p, writingAgentId: v }))}
                placeholder="Who wrote the business"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Upline agent *</Label>
              <AgentPicker
                aria-label="Upline agent"
                triggerClassName="h-9 text-sm"
                value={form.uplineAgentId}
                onChange={(v) => setForm((p) => ({ ...p, uplineAgentId: v }))}
                placeholder="Who earns the override"
              />
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
    </SectionCard>
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
    <SectionCard
      title="Missed payments"
      description="Policies where a carrier payment was expected but hasn't shown up on a statement"
      icon={AlertTriangle}
    >
      <FilterBar>
        <Label className="text-xs text-muted-foreground">Days overdue ≥</Label>
        <Input
          type="number"
          min="0"
          className="w-24 h-9"
          value={daysFilter}
          onChange={(e) => { setDaysFilter(e.target.value); setPage(1); }}
        />
      </FilterBar>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No missed payments — nice"
          description="Every commission we expected has turned up on a carrier statement. We check again each time a statement is reconciled."
        />
      ) : (
        <>
          <TableFrame>
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
                      <StatusPill tone={mp.daysOverdue >= 60 ? "danger" : mp.daysOverdue >= 30 ? "warning" : "neutral"}>
                        {mp.daysOverdue} days
                      </StatusPill>
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
          </TableFrame>
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
    </SectionCard>
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

  const period = data?.periodLabel ?? "this period";
  const agents = data?.agentsOnPayouts;
  const missed = data?.missedPaymentsCount;

  return (
    <KpiGrid>
      <KpiCard
        label={`Earned · ${period}`}
        value={fmtMoney(data?.earnedThisPeriod)}
        icon={DollarSign}
        color="navy"
        loading={isLoading}
        hint={agents != null ? `${agents} agent${agents === 1 ? "" : "s"} on payouts` : undefined}
      />
      <KpiCard
        label="Paid out"
        value={fmtMoney(data?.paidThisPeriod)}
        icon={Wallet}
        color="green"
        loading={isLoading}
        hint={`Sent to agents · ${period}`}
      />
      <KpiCard
        label="Waiting to be paid"
        value={fmtMoney(data?.pendingThisPeriod)}
        icon={Clock}
        color="blue"
        loading={isLoading}
        hint="Earned, not yet paid out"
      />
      <KpiCard
        label="Missed payments"
        value={missed != null ? String(missed) : "—"}
        icon={missed === 0 ? CheckCircle2 : AlertTriangle}
        color="orange"
        loading={isLoading}
        hint={missed === 0 ? "All carrier payments accounted for" : missed != null ? "Open — check the Missed payments tab" : undefined}
      />
    </KpiGrid>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CommissionsPage() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tab, setTab] = useState<"statements" | "schedules" | "hierarchies" | "missed">("statements");

  return (
    <PageShell>
      <PageHeader
        title="Commissions"
        subtitle="Carrier statements, rate cards, upline splits and anything that didn't get paid"
      >
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="h-4 w-4 mr-1.5" />
          Upload statement
        </Button>
      </PageHeader>

      <KpiRow />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="space-y-4">
        <TabsList className="h-10">
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
    </PageShell>
  );
}
