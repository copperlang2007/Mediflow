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
import { Megaphone, Plus, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid, FilterBar } from "@/components/ops";
import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";

type Status =
  | "draft"
  | "submitted"
  | "in_review"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "retired";
type MaterialType =
  | "flyer"
  | "social_post"
  | "email"
  | "mailer"
  | "tv"
  | "radio"
  | "web"
  | "business_card"
  | "presentation"
  | "script"
  | "other";

interface Material {
  id: string;
  title: string;
  materialType: MaterialType;
  status: Status;
  description: string | null;
  fileUrl: string | null;
  carrierName: string | null;
  cmsMaterialId: string | null;
  effectiveDate: string | null;
  expiresAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

interface MaterialRow {
  material: Material;
  submitterName: string | null;
}

interface Summary {
  draft: number;
  submitted: number;
  in_review: number;
  approved: number;
  rejected: number;
  changes_requested: number;
  retired: number;
  pendingReview: number;
  expiringSoon: number;
  expired: number;
  total: number;
}

const STATUS_CONFIG: Record<Status, { label: string; tone: StatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Submitted", tone: "info" },
  in_review: { label: "In review", tone: "navy" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  changes_requested: { label: "Changes requested", tone: "warning" },
  retired: { label: "Retired", tone: "neutral" },
};

const TYPE_LABEL: Record<MaterialType, string> = {
  flyer: "Flyer",
  social_post: "Social post",
  email: "Email",
  mailer: "Mailer",
  tv: "TV",
  radio: "Radio",
  web: "Web",
  business_card: "Business card",
  presentation: "Presentation",
  script: "Script",
  other: "Other",
};

const STATUSES = Object.keys(STATUS_CONFIG) as Status[];
const TYPES = Object.keys(TYPE_LABEL) as MaterialType[];
const QK = ["marketing-materials"] as const;
const QK_SUMMARY = ["marketing-materials", "summary"] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isExpiringSoon(m: Material): boolean {
  if (m.status !== "approved" || !m.expiresAt) return false;
  const days = (new Date(m.expiresAt).getTime() - Date.now()) / 86_400_000;
  return days >= 0 && days < 30;
}
function isExpired(m: Material): boolean {
  return m.status === "approved" && m.expiresAt !== null && new Date(m.expiresAt).getTime() < Date.now();
}

function SubmitDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [materialType, setMaterialType] = useState<MaterialType>("flyer");
  const [carrierName, setCarrierName] = useState("");
  const [fileUrl, setFileUrl] = useState("");

  const create = useMutation({
    mutationFn: () =>
      customFetch<Material>("/api/marketing-materials", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description || null,
          materialType,
          carrierName: carrierName || null,
          fileUrl: fileUrl || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Submitted for review");
      void qc.invalidateQueries({ queryKey: QK });
      void qc.invalidateQueries({ queryKey: QK_SUMMARY });
      setOpen(false);
      setTitle("");
      setDescription("");
      setMaterialType("flyer");
      setCarrierName("");
      setFileUrl("");
    },
    onError: () => toast.error("Failed to submit material"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-1.5" />
          Submit material
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit marketing material for review</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mkt-title">Title</Label>
            <Input id="mkt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fall AEP flyer" maxLength={500} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={materialType} onValueChange={(v) => setMaterialType(v as MaterialType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mkt-carrier">Carrier / product</Label>
              <Input id="mkt-carrier" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mkt-file">Asset link</Label>
            <Input id="mkt-file" value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} placeholder="https://… (optional)" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mkt-desc">Description</Label>
            <Textarea id="mkt-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What is this piece and where will it be used?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={title.trim().length === 0 || create.isPending}>
            {create.isPending ? "Submitting…" : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MaterialCard({ row }: { row: MaterialRow }) {
  const qc = useQueryClient();
  const m = row.material;

  const update = useMutation({
    mutationFn: (status: Status) =>
      customFetch<Material>(`/api/marketing-materials/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      toast.success("Material updated");
      void qc.invalidateQueries({ queryKey: QK });
      void qc.invalidateQueries({ queryKey: QK_SUMMARY });
    },
    onError: () => toast.error("Failed to update material"),
  });

  const expiringSoon = isExpiringSoon(m);
  const expired = isExpired(m);

  return (
    <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/30">
        <div className="flex items-start justify-between gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Megaphone className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{m.title}</span>
              <StatusPill tone={STATUS_CONFIG[m.status].tone}>
                {STATUS_CONFIG[m.status].label}
              </StatusPill>
              <StatusPill tone="neutral">{TYPE_LABEL[m.materialType]}</StatusPill>
              {expired && (
                <StatusPill tone="danger" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />Expired
                </StatusPill>
              )}
              {!expired && expiringSoon && (
                <StatusPill tone="warning" className="gap-1">
                  <Clock className="h-3 w-3" />Expiring soon
                </StatusPill>
              )}
            </div>
            {m.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{m.description}</p>}
            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground mt-2">
              {m.carrierName && <span>{m.carrierName}</span>}
              {m.cmsMaterialId && <span>CMS #{m.cmsMaterialId}</span>}
              {row.submitterName && <span>By {row.submitterName}</span>}
              {m.status === "approved" && <span>Use {fmtDate(m.effectiveDate)} – {fmtDate(m.expiresAt)}</span>}
              {m.fileUrl && (
                <a href={m.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  View asset <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {m.reviewNotes && (
              <p className="text-xs mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-amber-800 dark:text-warning">Reviewer note: {m.reviewNotes}</p>
            )}
          </div>
          <div className="shrink-0">
            <Select value={m.status} onValueChange={(v) => update.mutate(v as Status)}>
              <SelectTrigger className="w-[170px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
    </div>
  );
}

export default function MarketingPage() {
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | MaterialType>("all");

  const { data: summary } = useQuery({
    queryKey: QK_SUMMARY,
    queryFn: () => customFetch<Summary>("/api/marketing-materials/summary"),
    staleTime: 30_000,
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: [...QK, statusFilter, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("materialType", typeFilter);
      const qs = params.toString();
      return customFetch<MaterialRow[]>(`/api/marketing-materials${qs ? `?${qs}` : ""}`);
    },
  });

  const filtered = statusFilter !== "all" || typeFilter !== "all";
  const total = summary?.total ?? 0;

  return (
    <PageShell>
      <PageHeader
        title="Marketing Approval"
        subtitle="Get flyers, ads and scripts approved before anyone uses them — only approved, in-date pieces are safe to share"
      >
        <SubmitDialog />
      </PageHeader>

      <KpiGrid>
        <button
          type="button"
          className="text-left"
          onClick={() => setStatusFilter((s) => (s === "submitted" ? "all" : "submitted"))}
          aria-pressed={statusFilter === "submitted"}
        >
          <KpiCard
            label="Waiting for review"
            value={summary?.pendingReview ?? 0}
            icon={Megaphone}
            color="navy"
            className={cn("hover:shadow-lg", statusFilter === "submitted" && "ring-2 ring-offset-2 ring-accent ring-offset-background")}
            hint={(summary?.pendingReview ?? 0) === 0 ? "Review queue is clear" : "Click to show only these"}
          />
        </button>
        <button
          type="button"
          className="text-left"
          onClick={() => setStatusFilter((s) => (s === "approved" ? "all" : "approved"))}
          aria-pressed={statusFilter === "approved"}
        >
          <KpiCard
            label="Approved"
            value={summary?.approved ?? 0}
            icon={CheckCircle2}
            color="green"
            className={cn("hover:shadow-lg", statusFilter === "approved" && "ring-2 ring-offset-2 ring-success ring-offset-background")}
            hint="Safe to use while in date"
          />
        </button>
        <KpiCard
          label="Expiring in 30 days"
          value={summary?.expiringSoon ?? 0}
          icon={Clock}
          color="blue"
          hint={(summary?.expiringSoon ?? 0) === 0 ? "Nothing expiring soon" : "Plan a refresh"}
        />
        <KpiCard
          label="Expired"
          value={summary?.expired ?? 0}
          icon={AlertTriangle}
          color="orange"
          hint={(summary?.expired ?? 0) === 0 ? "Nothing out of date — nice" : "Stop using these"}
        />
      </KpiGrid>

      <SectionCard title="Materials" description="Everything submitted, newest first. Reviewers can change the status on each row.">
      <FilterBar>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | Status)}>
          <SelectTrigger className="w-[180px] h-9"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as "all" | MaterialType)}>
          <SelectTrigger className="w-[170px] h-9"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
          </SelectContent>
        </Select>
      </FilterBar>

      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : (rows ?? []).length === 0 ? (
        filtered || total > 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No marketing materials match the current filters."
            description="Try a different status or type."
          />
        ) : (
          <EmptyState
            icon={Megaphone}
            title="Nothing submitted yet"
            description="Before you share a flyer, social post or call script with clients, submit it here. A reviewer approves it and sets the dates it can be used."
          >
            <SubmitDialog />
          </EmptyState>
        )
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((row) => <MaterialCard key={row.material.id} row={row} />)}
        </div>
      )}
      </SectionCard>
    </PageShell>
  );
}
