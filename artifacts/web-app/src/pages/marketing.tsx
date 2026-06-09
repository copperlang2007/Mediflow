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

const STATUS_CONFIG: Record<Status, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600 border-slate-200" },
  submitted: { label: "Submitted", className: "bg-blue-100 text-blue-800 border-blue-200" },
  in_review: { label: "In review", className: "bg-violet-100 text-violet-800 border-violet-200" },
  approved: { label: "Approved", className: "bg-green-100 text-green-800 border-green-200" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800 border-red-200" },
  changes_requested: { label: "Changes requested", className: "bg-amber-100 text-amber-800 border-amber-200" },
  retired: { label: "Retired", className: "bg-slate-100 text-slate-500 border-slate-200" },
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
        <Button size="sm">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
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
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{m.title}</span>
              <Badge variant="outline" className={STATUS_CONFIG[m.status].className}>
                {STATUS_CONFIG[m.status].label}
              </Badge>
              <Badge variant="outline">{TYPE_LABEL[m.materialType]}</Badge>
              {expired && (
                <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">
                  <AlertTriangle className="h-3 w-3 mr-1" />Expired
                </Badge>
              )}
              {!expired && expiringSoon && (
                <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200">
                  <Clock className="h-3 w-3 mr-1" />Expiring soon
                </Badge>
              )}
            </div>
            {m.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{m.description}</p>}
            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground mt-2">
              {m.carrierName && <span>{m.carrierName}</span>}
              {m.cmsMaterialId && <span>CMS #{m.cmsMaterialId}</span>}
              {row.submitterName && <span>By {row.submitterName}</span>}
              {m.status === "approved" && <span>Use {fmtDate(m.effectiveDate)} – {fmtDate(m.expiresAt)}</span>}
              {m.fileUrl && (
                <a href={m.fileUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  View asset
                </a>
              )}
            </div>
            {m.reviewNotes && (
              <p className="text-xs mt-1.5 text-amber-700">Reviewer: {m.reviewNotes}</p>
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
      </CardContent>
    </Card>
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

  const cards = [
    { key: "pendingReview", label: "Pending review", value: summary?.pendingReview ?? 0, icon: Megaphone, className: "text-blue-600" },
    { key: "approved", label: "Approved", value: summary?.approved ?? 0, icon: CheckCircle2, className: "text-green-600" },
    { key: "expiringSoon", label: "Expiring soon", value: summary?.expiringSoon ?? 0, icon: Clock, className: "text-amber-600" },
    { key: "expired", label: "Expired", value: summary?.expired ?? 0, icon: AlertTriangle, className: "text-red-600" },
  ] as const;

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Marketing Approval</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Submit and review marketing materials — only approved, in-window pieces should be used
          </p>
        </div>
        <SubmitDialog />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.key}
              onClick={() => {
                if (card.key === "pendingReview") setStatusFilter((s) => (s === "submitted" ? "all" : "submitted"));
                else if (card.key === "approved") setStatusFilter((s) => (s === "approved" ? "all" : "approved"));
              }}
              className="rounded-lg border p-4 text-left transition-all hover:shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</span>
                <Icon className={`h-4 w-4 ${card.className}`} />
              </div>
              <div className={`text-2xl font-bold mt-1 ${card.className}`}>{card.value}</div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
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
      </div>

      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : (rows ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No marketing materials match the current filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((row) => <MaterialCard key={row.material.id} row={row} />)}
        </div>
      )}
    </div>
  );
}
