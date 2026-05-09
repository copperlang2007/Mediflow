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

const CATEGORY_BADGE_COLOR: Record<string, string> = {
  contract: "bg-blue-100 text-blue-800",
  eo_certificate: "bg-purple-100 text-purple-800",
  compliance: "bg-amber-100 text-amber-800",
  license: "bg-teal-100 text-teal-800",
  training: "bg-indigo-100 text-indigo-800",
  other: "bg-slate-100 text-slate-700",
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

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Documents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Contracts, E&amp;O certificates, and compliance files for your agents
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Upload document
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
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
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : documents.length === 0 ? (
            <div className="py-16 text-center">
              <FolderOpen className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">
                No documents
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {agentFilter !== "all" || categoryFilter !== "all"
                  ? "Try adjusting your filters"
                  : "Upload your first document to get started"}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-4 px-5 py-2.5 border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Name</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-40">Agent</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-32 text-center">Category</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-20 text-right">Size</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-28 text-right">Uploaded</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24 text-right">Actions</span>
              </div>
              <div className="divide-y divide-border">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-4 px-5 py-3 hover:bg-muted/30 transition-colors"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm truncate">{doc.name}</span>
                    </div>
                    <div className="w-40 text-sm text-muted-foreground truncate">
                      {doc.agentFirstName ? `${doc.agentFirstName} ${doc.agentLastName ?? ""}`.trim() : "—"}
                    </div>
                    <div className="w-32 flex justify-center">
                      <Badge
                        variant="secondary"
                        className={`text-xs capitalize ${CATEGORY_BADGE_COLOR[doc.category] ?? ""}`}
                      >
                        {CATEGORY_LABEL[doc.category] ?? doc.category}
                      </Badge>
                    </div>
                    <div className="w-20 text-right tabular-nums text-xs text-muted-foreground">
                      {formatBytes(doc.fileSizeBytes)}
                    </div>
                    <div className="w-28 text-right text-xs text-muted-foreground">
                      {format(new Date(doc.createdAt), "MMM d, yyyy")}
                    </div>
                    <div className="w-24 flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        title="Download"
                        onClick={() => handleDownload(doc)}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => handleDelete(doc)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        agents={agents}
        onUploaded={() => void qc.invalidateQueries({ queryKey: ["/api/documents"] })}
      />
    </div>
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
