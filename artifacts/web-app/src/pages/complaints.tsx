import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types (shape returned by routes/complaints.ts) ───────────────────────────
type Severity = "low" | "medium" | "high" | "critical";
type Status = "open" | "investigating" | "resolved" | "closed";
type Category =
  | "marketing"
  | "enrollment"
  | "benefits"
  | "access"
  | "privacy"
  | "agent_conduct"
  | "billing"
  | "other";
type Source = "cms_ctm" | "beneficiary_direct" | "carrier" | "internal" | "other";

interface Complaint {
  id: string;
  subject: string;
  description: string | null;
  source: Source;
  category: Category;
  severity: Severity;
  status: Status;
  ctmCaseId: string | null;
  receivedAt: string;
  dueAt: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
}

interface ComplaintRow {
  complaint: Complaint;
  contactFirstName: string | null;
  contactLastName: string | null;
  agentFirstName: string | null;
  agentLastName: string | null;
  assigneeName: string | null;
}

interface ComplaintSummary {
  open: number;
  investigating: number;
  resolved: number;
  closed: number;
  active: number;
  overdue: number;
  total: number;
}

const SEVERITY_CONFIG: Record<Severity, { label: string; className: string }> = {
  critical: { label: "Critical", className: "bg-red-100 text-red-800 border-red-200" },
  high: { label: "High", className: "bg-orange-100 text-orange-800 border-orange-200" },
  medium: { label: "Medium", className: "bg-amber-100 text-amber-800 border-amber-200" },
  low: { label: "Low", className: "bg-slate-100 text-slate-700 border-slate-200" },
};

const STATUS_CONFIG: Record<Status, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-blue-100 text-blue-800 border-blue-200" },
  investigating: { label: "Investigating", className: "bg-violet-100 text-violet-800 border-violet-200" },
  resolved: { label: "Resolved", className: "bg-green-100 text-green-800 border-green-200" },
  closed: { label: "Closed", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

const CATEGORY_LABEL: Record<Category, string> = {
  marketing: "Marketing",
  enrollment: "Enrollment",
  benefits: "Benefits",
  access: "Access",
  privacy: "Privacy",
  agent_conduct: "Agent conduct",
  billing: "Billing",
  other: "Other",
};

const SOURCE_LABEL: Record<Source, string> = {
  cms_ctm: "CMS CTM",
  beneficiary_direct: "Beneficiary",
  carrier: "Carrier",
  internal: "Internal",
  other: "Other",
};

const STATUSES: Status[] = ["open", "investigating", "resolved", "closed"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];
const SOURCES = Object.keys(SOURCE_LABEL) as Source[];

function isOverdue(c: Complaint): boolean {
  return (
    (c.status === "open" || c.status === "investigating") &&
    c.dueAt !== null &&
    new Date(c.dueAt).getTime() < Date.now()
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const QK = ["complaints"] as const;
const QK_SUMMARY = ["complaints", "summary"] as const;

// ─── Log-complaint dialog ─────────────────────────────────────────────────────
function LogComplaintDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [category, setCategory] = useState<Category>("other");
  const [source, setSource] = useState<Source>("beneficiary_direct");
  const [ctmCaseId, setCtmCaseId] = useState("");

  const create = useMutation({
    mutationFn: () =>
      customFetch<Complaint>("/api/complaints", {
        method: "POST",
        body: JSON.stringify({
          subject,
          description: description || null,
          severity,
          category,
          source,
          ctmCaseId: ctmCaseId || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Complaint logged");
      void qc.invalidateQueries({ queryKey: QK });
      void qc.invalidateQueries({ queryKey: QK_SUMMARY });
      setOpen(false);
      setSubject("");
      setDescription("");
      setSeverity("medium");
      setCategory("other");
      setSource("beneficiary_direct");
      setCtmCaseId("");
    },
    onError: () => toast.error("Failed to log complaint"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Log complaint
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log a complaint</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cmpl-subject">Subject</Label>
            <Input
              id="cmpl-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Short summary (no member ID or PHI)"
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cmpl-desc">Description</Label>
            <Textarea
              id="cmpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened — keep it free of MBI / PHI"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>{SEVERITY_CONFIG[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as Source)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>{SOURCE_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cmpl-ctm">CMS CTM case #</Label>
              <Input
                id="cmpl-ctm"
                value={ctmCaseId}
                onChange={(e) => setCtmCaseId(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The resolution due date is set from severity — critical 2 days, high 5,
            medium 10, low 30.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={subject.trim().length === 0 || create.isPending}
          >
            {create.isPending ? "Saving…" : "Log complaint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────
function ComplaintCard({ row }: { row: ComplaintRow }) {
  const qc = useQueryClient();
  const c = row.complaint;
  const overdue = isOverdue(c);

  const update = useMutation({
    mutationFn: (status: Status) =>
      customFetch<Complaint>(`/api/complaints/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      toast.success("Complaint updated");
      void qc.invalidateQueries({ queryKey: QK });
      void qc.invalidateQueries({ queryKey: QK_SUMMARY });
    },
    onError: () => toast.error("Failed to update complaint"),
  });

  const contactName = row.contactFirstName
    ? `${row.contactFirstName} ${row.contactLastName ?? ""}`.trim()
    : null;
  const agentName = row.agentFirstName
    ? `${row.agentFirstName} ${row.agentLastName ?? ""}`.trim()
    : null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{c.subject}</span>
              <Badge variant="outline" className={SEVERITY_CONFIG[c.severity].className}>
                {SEVERITY_CONFIG[c.severity].label}
              </Badge>
              <Badge variant="outline" className={STATUS_CONFIG[c.status].className}>
                {STATUS_CONFIG[c.status].label}
              </Badge>
              {overdue && (
                <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Overdue
                </Badge>
              )}
            </div>
            {c.description && (
              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{c.description}</p>
            )}
            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground mt-2">
              <span>{SOURCE_LABEL[c.source]}</span>
              <span>{CATEGORY_LABEL[c.category]}</span>
              {c.ctmCaseId && <span>CTM #{c.ctmCaseId}</span>}
              {contactName && <span>Beneficiary: {contactName}</span>}
              {agentName && <span>Agent: {agentName}</span>}
              <span className={overdue ? "text-red-600 font-medium" : ""}>
                <Clock className="h-3 w-3 inline mr-1" />
                Due {fmtDate(c.dueAt)}
              </span>
              {row.assigneeName && <span>Owner: {row.assigneeName}</span>}
            </div>
          </div>
          <div className="shrink-0">
            <Select value={c.status} onValueChange={(v) => update.mutate(v as Status)}>
              <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ComplaintsPage() {
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [severityFilter, setSeverityFilter] = useState<"all" | Severity>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const { data: summary } = useQuery({
    queryKey: QK_SUMMARY,
    queryFn: () => customFetch<ComplaintSummary>("/api/complaints/summary"),
    staleTime: 30_000,
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: [...QK, statusFilter, severityFilter, overdueOnly],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (overdueOnly) params.set("overdue", "true");
      const qs = params.toString();
      return customFetch<ComplaintRow[]>(`/api/complaints${qs ? `?${qs}` : ""}`);
    },
  });

  const cards: Array<{ key: string; label: string; value: number; icon: typeof ShieldAlert; className: string }> = [
    { key: "active", label: "Active", value: summary?.active ?? 0, icon: ShieldAlert, className: "text-blue-600" },
    { key: "overdue", label: "Overdue", value: summary?.overdue ?? 0, icon: AlertTriangle, className: "text-red-600" },
    { key: "resolved", label: "Resolved", value: summary?.resolved ?? 0, icon: CheckCircle2, className: "text-green-600" },
    { key: "total", label: "Total", value: summary?.total ?? 0, icon: ShieldAlert, className: "text-slate-600" },
  ];

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Complaints</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Log, triage, and resolve beneficiary complaints (CMS CTM) within SLA
          </p>
        </div>
        <LogComplaintDialog />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.key}
              onClick={() => {
                if (card.key === "overdue") {
                  setOverdueOnly((v) => !v);
                } else if (card.key === "resolved") {
                  setStatusFilter((s) => (s === "resolved" ? "all" : "resolved"));
                }
              }}
              className="rounded-lg border p-4 text-left transition-all hover:shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {card.label}
                </span>
                <Icon className={`h-4 w-4 ${card.className}`} />
              </div>
              <div className={`text-2xl font-bold mt-1 ${card.className}`}>{card.value}</div>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | Status)}>
          <SelectTrigger className="w-[160px] h-9"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severityFilter} onValueChange={(v) => setSeverityFilter(v as "all" | Severity)}>
          <SelectTrigger className="w-[160px] h-9"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>{SEVERITY_CONFIG[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={overdueOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setOverdueOnly((v) => !v)}
        >
          <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
          Overdue only
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (rows ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No complaints match the current filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((row) => <ComplaintCard key={row.complaint.id} row={row} />)}
        </div>
      )}
    </div>
  );
}
