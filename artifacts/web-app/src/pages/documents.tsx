import { useState, useRef } from "react";
import {
  useGetAgents,
  useRequestUploadUrl,
  useCreateAgentDocument,
  useDeleteDocument,
  customFetch,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import { FolderOpen, Upload, Download, Trash2, Plus, FileText } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { PageHeader, MiniStat, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell } from "@/components/ops";
import { FileSignature, ShieldCheck, Users } from "lucide-react";

type DocumentRow = {
  id: string;
  orgId: string;
  agentId: string | null;
  name: string;
  category: string;
  storageKey: string;
  fileSizeBytes: number | null;
  mimeType: string | null;
  uploadedBy: string | null;
  createdAt: string;
  agentFirstName: string | null;
  agentLastName: string | null;
};

const CATEGORIES = [
  { value: "contract", label: "Contract" },
  { value: "eo_certificate", label: "E&O Certificate" },
  { value: "compliance", label: "Compliance" },
  { value: "license", label: "License" },
  { value: "training", label: "Training" },
  { value: "other", label: "Other" },
];

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

const CATEGORY_TONE: Record<string, StatusTone> = {
  contract: "navy",
  eo_certificate: "info",
  compliance: "warning",
  license: "success",
  training: "info",
  other: "neutral",
};

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export default function DocumentsPage() {
  const qc = useQueryClient();
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data: agentsData } = useGetAgents({ limit: 500 });
  const agents = agentsData?.agents ?? [];

  const documentsQueryKey = [
    "/api/documents",
    agentFilter,
    categoryFilter,
  ] as const;

  const { data: docsData, isLoading } = useQuery({
    queryKey: documentsQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (agentFilter !== "all") params.set("agentId", agentFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      const qs = params.toString();
      return customFetch<{ documents: DocumentRow[]; total: number }>(
        `/api/documents${qs ? `?${qs}` : ""}`,
      );
    },
    staleTime: 30_000,
  });
  const documents = docsData?.documents ?? [];

  const { mutateAsync: deleteDocument } = useDeleteDocument();

  const handleDelete = async (doc: DocumentRow) => {
    if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
    try {
      await deleteDocument({ docId: doc.id });
      toast.success("Document deleted");
      void qc.invalidateQueries({ queryKey: ["/api/documents"] });
    } catch {
      toast.error("Failed to delete document");
    }
  };

  const handleDownload = (doc: DocumentRow) => {
    // The download endpoint streams via signed URL with ACL enforcement.
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    window.open(`${base}/api/documents/${doc.id}/download`, "_blank");
  };

  const filtered = agentFilter !== "all" || categoryFilter !== "all";
  const countOf = (cat: string) => documents.filter((d) => d.category === cat).length;
  const agentsWithFiles = new Set(documents.map((d) => d.agentId).filter(Boolean)).size;

  return (
    <PageShell>
      <PageHeader
        title="Documents"
        subtitle="Contracts, E&O certificates, licenses and compliance files for your agents in one secure place"
      >
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="h-4 w-4 mr-1.5" />
          Upload document
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MiniStat label={filtered ? "Documents (filtered)" : "Total documents"} value={docsData?.total ?? 0} icon={FolderOpen} loading={isLoading} />
        <MiniStat label="Contracts" value={countOf("contract")} icon={FileSignature} loading={isLoading} />
        <MiniStat label="E&O certificates" value={countOf("eo_certificate")} icon={ShieldCheck} loading={isLoading} />
        <MiniStat label="Agents with files" value={agentsWithFiles} icon={Users} loading={isLoading} />
      </div>

      <SectionCard
        title="Agent documents"
        description="Only people allowed to see agent records can open or download these files"
        icon={FileText}
      >
      <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center">
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.firstName} {a.lastName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          {[{ value: "all", label: "All" }, ...CATEGORIES].map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setCategoryFilter(c.value)}
              aria-pressed={categoryFilter === c.value}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                categoryFilter === c.value
                  ? "border-navy-800 bg-navy-800 text-white dark:border-primary dark:bg-primary dark:text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : documents.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title={filtered ? "No documents match these filters" : "No documents yet"}
              description={
                filtered
                  ? "Try adjusting your filters"
                  : "Upload an agent's contract, E&O certificate or license and it will be stored here, ready to download when an auditor or carrier asks."
              }
              action={filtered ? undefined : { label: "Upload document", onClick: () => setUploadOpen(true) }}
            />
          ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <FileText className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{doc.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {doc.agentFirstName ? `${doc.agentFirstName} ${doc.agentLastName ?? ""}`.trim() : "No agent"}
                        {" · "}
                        {formatBytes(doc.fileSizeBytes)}
                      </p>
                    </div>
                    <StatusPill tone={CATEGORY_TONE[doc.category] ?? "neutral"} className="hidden sm:inline-flex">
                      {CATEGORY_LABEL[doc.category] ?? doc.category}
                    </StatusPill>
                    <span className="hidden md:block w-28 text-right text-xs text-muted-foreground">
                      {format(new Date(doc.createdAt), "MMM d, yyyy")}
                    </span>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2"
                        title="Download"
                        onClick={() => handleDownload(doc)}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => handleDelete(doc)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
          )}
      </SectionCard>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        agents={agents}
        onUploaded={() => void qc.invalidateQueries({ queryKey: ["/api/documents"] })}
      />
    </PageShell>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  agents,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agents: Array<{ id: string; firstName: string; lastName: string }>;
  onUploaded: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [category, setCategory] = useState<string>("contract");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const { mutateAsync: requestUploadUrl } = useRequestUploadUrl();
  const { mutateAsync: createAgentDocument } = useCreateAgentDocument();

  const reset = () => {
    setAgentId("");
    setCategory("contract");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || !file) {
      toast.error("Pick an agent and a file");
      return;
    }
    setUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl({
        data: {
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        },
      });
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error(`Upload failed (HTTP ${putRes.status})`);

      await createAgentDocument({
        id: agentId,
        data: {
          name: file.name,
          category,
          storageKey: objectPath,
          fileSizeBytes: file.size,
          mimeType: file.type || undefined,
        },
      });
      toast.success("Document uploaded");
      onUploaded();
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload document");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="doc-agent">Agent *</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger id="doc-agent">
                <SelectValue placeholder="Select an agent…" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.firstName} {a.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-category">Category *</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="doc-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-file">File *</Label>
            <Input
              ref={fileInputRef}
              id="doc-file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={uploading || !agentId || !file}>
              {uploading ? (
                "Uploading…"
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-1.5" />
                  Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
