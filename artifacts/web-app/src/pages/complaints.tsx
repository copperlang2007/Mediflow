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
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid, FilterBar } from "@/components/ops";
import { ListChecks, Smile } from "lucide-react";
import { cn } from "@/lib/utils";

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

const SEVERITY_CONFIG: Record<Severity, { label: string; tone: StatusTone }> = {
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "danger" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "neutral" },
};

const STATUS_CONFIG: Record<Status, { label: string; tone: StatusTone }> = {
  open: { label: "Open", tone: "info" },
  investigating: { label: "Investigating", tone: "navy" },
  resolved: { label: "Resolved", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

const SEVERITY_BAR: Record<Severity, string> = {
  critical: "bg-destructive",
  high: "bg-orange-500",
  medium: "bg-warning",
  low: "bg-muted-foreground/30",
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
        <Button>
          <Plus className="h-4 w-4 mr-1.5" />
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
    <div className="relative overflow-hidden rounded-lg border border-border bg-card p-4 pl-5 transition-colors hover:bg-muted/30">
      <span className={cn("absolute inset-y-0 left-0 w-1", SEVERITY_BAR[c.severity])} aria-hidden />
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{c.subject}</span>
              <StatusPill tone={SEVERITY_CONFIG[c.severity].tone}>
                {SEVERITY_CONFIG[c.severity].label}
              </StatusPill>
              <StatusPill tone={STATUS_CONFIG[c.status].tone}>
                {STATUS_CONFIG[c.status].label}
              </StatusPill>
              {overdue && (
                <StatusPill tone="danger" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Overdue
                </StatusPill>
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
              <span className={overdue ? "text-destructive font-medium" : ""}>
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
    </div>
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

  const total = summary?.total ?? 0;
  const filtered = statusFilter !== "all" || severityFilter !== "all" || overdueOnly;

  return (
    <PageShell>
      <PageHeader
        title="Complaints"
        subtitle="Log, look into and resolve member complaints (including CMS CTM cases) before they're due"
      >
        <LogComplaintDialog />
      </PageHeader>

      <KpiGrid>
        <KpiCard
          label="Active"
          value={summary?.active ?? 0}
          icon={ShieldAlert}
          color="navy"
          hint={summary && summary.active === 0 ? "Nothing open right now" : "Open or being looked into"}
        />
        <button type="button" className="text-left" onClick={() => setOverdueOnly((v) => !v)} aria-pressed={overdueOnly}>
          <KpiCard
            label="Overdue"
            value={summary?.overdue ?? 0}
            icon={AlertTriangle}
            color="orange"
            className={cn("hover:shadow-lg", overdueOnly && "ring-2 ring-offset-2 ring-warning ring-offset-background")}
            hint={summary && summary.overdue === 0 ? "Everything is on time" : overdueOnly ? "Showing overdue only" : "Click to show only these"}
          />
        </button>
        <button
          type="button"
          className="text-left"
          onClick={() => setStatusFilter((s) => (s === "resolved" ? "all" : "resolved"))}
          aria-pressed={statusFilter === "resolved"}
        >
          <KpiCard
            label="Resolved"
            value={summary?.resolved ?? 0}
            icon={CheckCircle2}
            color="green"
            className={cn("hover:shadow-lg", statusFilter === "resolved" && "ring-2 ring-offset-2 ring-success ring-offset-background")}
            hint={statusFilter === "resolved" ? "Showing resolved only" : "Click to show only these"}
          />
        </button>
        <KpiCard
          label="All time"
          value={total}
          icon={ListChecks}
          color="blue"
          hint={total === 0 ? "No complaints logged — nice" : "Every complaint logged"}
        />
      </KpiGrid>

      <SectionCard title="Complaint log" description="Newest first. Change the status right on each row.">
      {/* Filters */}
      <FilterBar>
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
      </FilterBar>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (rows ?? []).length === 0 ? (
        filtered ? (
          <EmptyState
            icon={ShieldAlert}
            title="No complaints match the current filters."
            description="Try a different status or severity."
          />
        ) : (
          <EmptyState
            icon={Smile}
            title="No complaints logged — nice"
            description="When a member or CMS raises a complaint, log it here. We set a due date from its severity and flag it if it runs late."
          />
        )
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((row) => <ComplaintCard key={row.complaint.id} row={row} />)}
        </div>
      )}
      </SectionCard>
    </PageShell>
  );
}
