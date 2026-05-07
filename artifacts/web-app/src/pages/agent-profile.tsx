import { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetAgent,
  useUpdateAgent,
  useOffboardAgent,
  useGetAgentLicenses,
  useCreateAgentLicense,
  useUpdateAgentLicense,
  useDeleteAgentLicense,
  useGetAgentCertifications,
  useCreateAgentCertification,
  useUpdateAgentCertification,
  useGetCarriers,
  useGetAgentAhip,
  useCreateAgentAhip,
  useUpdateAgentAhip,
  useGetAgentChecklists,
  useGetAgentChecklist,
  useUpdateChecklistItem,
  useGetAgentTechStack,
  useCreateAgentTechStackAccount,
  useUpdateAgentTechStackAccount,
  useBulkUpdateAgentTechStack,
  useRequestUploadUrl,
  useGetAgentTasks,
  useCreateTask,
  useGetAuditLog,
  useGetAgentDocuments,
  useGetAgentOffboardingReport,
  useGetAgentComplianceScore,
  getGetAgentLicensesQueryKey,
  getGetAgentCertificationsQueryKey,
  getGetAgentAhipQueryKey,
  getGetAgentChecklistsQueryKey,
  getGetAgentChecklistQueryKey,
  getGetAgentTechStackQueryKey,
  getGetAgentTasksQueryKey,
  getGetAgentQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  Award,
  CheckSquare,
  FileText,
  FolderOpen,
  Monitor,
  ShieldCheck,
  Upload,
  Link,
  User,
  Plus,
  Check,
  X,
  SkipForward,
  FileDown,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  onboarding: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-green-100 text-green-800 border-green-200",
  suspended: "bg-red-100 text-red-800 border-red-200",
  offboarding: "bg-orange-100 text-orange-800 border-orange-200",
  offboarded: "bg-slate-100 text-slate-600 border-slate-200",
};

const CERT_STATUS_STYLES: Record<string, string> = {
  passed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  in_progress: "bg-blue-100 text-blue-800",
  not_started: "bg-slate-100 text-slate-600",
  waived: "bg-purple-100 text-purple-800",
};

const LICENSE_STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  pending: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
  suspended: "bg-red-100 text-red-800",
  not_appointed: "bg-slate-100 text-slate-600",
};

type Tab = "overview" | "licenses" | "certifications" | "ahip" | "checklist" | "techstack" | "tasks" | "documents" | "activity";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", icon: User },
  { id: "licenses", label: "Licenses", icon: FileText },
  { id: "certifications", label: "Certifications", icon: Award },
  { id: "ahip", label: "AHIP", icon: ShieldCheck },
  { id: "checklist", label: "Checklist", icon: CheckSquare },
  { id: "techstack", label: "Tech Stack", icon: Monitor },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "documents", label: "Documents", icon: FolderOpen },
  { id: "activity", label: "Activity", icon: FileText },
];

function OverviewTab({ agentId }: { agentId: string }) {
  const { data: score } = useGetAgentComplianceScore(agentId);
  if (!score) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  const items = [
    { label: "License Score", value: score.licenseScore, detail: `${score.activeLicenses}/${score.totalLicenses} active` },
    { label: "Cert Score", value: score.certificationScore, detail: `${score.activeCertifications}/${score.totalCertifications} passed` },
    { label: "AHIP Score", value: score.ahipScore, detail: score.ahipCompleted ? "Completed" : "Not completed" },
    { label: "Onboarding Score", value: score.onboardingScore, detail: score.onboardingComplete ? "Complete" : "In progress" },
  ];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold">Overall Compliance Score</p>
          <span className={cn(
            "text-2xl font-bold tabular-nums",
            score.totalScore >= 80 ? "text-green-600" : score.totalScore >= 50 ? "text-amber-600" : "text-red-600"
          )}>
            {Math.round(score.totalScore)}%
          </span>
        </div>
        <Progress
          value={score.totalScore}
          className="h-2"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-lg border border-border p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <span className={cn(
                "text-sm font-bold tabular-nums",
                item.value >= 80 ? "text-green-600" : item.value >= 50 ? "text-amber-600" : "text-red-600"
              )}>
                {Math.round(item.value)}%
              </span>
            </div>
            <Progress value={item.value} className="h-1" />
            <p className="text-xs text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function LicensesTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: licenses, isLoading } = useGetAgentLicenses(agentId);
  const { mutateAsync: createLicense } = useCreateAgentLicense();
  const { mutateAsync: updateLicense } = useUpdateAgentLicense();
  const { mutateAsync: deleteLicense } = useDeleteAgentLicense();
  const { mutateAsync: requestUploadUrl } = useRequestUploadUrl();
  const [addOpen, setAddOpen] = useState(false);
  const [uploadingLicId, setUploadingLicId] = useState<string | null>(null);
  const [form, setForm] = useState({ stateCode: "", licenseType: "Life & Health", licenseNumber: "", expiryDate: "", status: "active" as string });

  const handleDocUpload = async (licId: string, file: File) => {
    setUploadingLicId(licId);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl({
        data: { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" },
      });
      const res = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!res.ok) throw new Error("Upload failed");
      await updateLicense({ id: agentId, lid: licId, data: { documentKey: objectPath } });
      toast.success("License document uploaded");
      void qc.invalidateQueries({ queryKey: getGetAgentLicensesQueryKey(agentId) });
    } catch { toast.error("Failed to upload document"); }
    finally { setUploadingLicId(null); }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createLicense({ id: agentId, data: { stateCode: form.stateCode.toUpperCase(), licenseType: form.licenseType, licenseNumber: form.licenseNumber || undefined, expiryDate: form.expiryDate || undefined, status: form.status as "active" | "pending" } });
      toast.success("License added");
      void qc.invalidateQueries({ queryKey: getGetAgentLicensesQueryKey(agentId) });
      setAddOpen(false);
    } catch { toast.error("Failed to add license"); }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{licenses?.length ?? 0} state license{licenses?.length !== 1 ? "s" : ""}</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add License
        </Button>
      </div>

      {(licenses ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No licenses recorded</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(licenses ?? []).map((lic) => (
            <div key={lic.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{lic.stateCode}</span>
                  <span className="text-sm text-muted-foreground">·</span>
                  <span className="text-sm">{lic.licenseType}</span>
                </div>
                {lic.licenseNumber && <p className="text-xs text-muted-foreground mt-0.5">#{lic.licenseNumber}</p>}
                {lic.expiryDate && (() => {
                  const daysLeft = Math.ceil((new Date(lic.expiryDate).getTime() - Date.now()) / 86400000);
                  const color = daysLeft <= 0 ? "text-red-600 font-semibold" : daysLeft <= 30 ? "text-red-600" : daysLeft <= 60 ? "text-amber-600" : daysLeft <= 90 ? "text-amber-500" : "text-muted-foreground";
                  return (
                    <p className={cn("text-xs mt-0.5", color)}>
                      Expires {format(new Date(lic.expiryDate), "MMM d, yyyy")}
                      {daysLeft <= 90 && daysLeft > 0 && ` · ${daysLeft}d`}
                      {daysLeft <= 0 && " · Expired"}
                    </p>
                  );
                })()}
              </div>
              <Badge variant="secondary" className={`text-xs capitalize ${LICENSE_STATUS_STYLES[lic.status] ?? ""}`}>
                {lic.status.replace("_", " ")}
              </Badge>
              {lic.documentKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-blue-600 hover:text-blue-700"
                  title="View document"
                  onClick={() => {
                    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
                    window.open(`${base}/api/storage/objects/${lic.documentKey}`, "_blank");
                  }}
                >
                  <Link className="h-3.5 w-3.5" />
                </Button>
              )}
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="hidden"
                  disabled={uploadingLicId === lic.id}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) await handleDocUpload(lic.id, file);
                    e.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-muted-foreground hover:text-foreground pointer-events-none"
                  title="Upload license document"
                  disabled={uploadingLicId === lic.id}
                  asChild={false}
                >
                  <Upload className={cn("h-3.5 w-3.5", uploadingLicId === lic.id && "animate-pulse")} />
                </Button>
              </label>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground h-7 px-2"
                onClick={async () => {
                  try {
                    await deleteLicense({ id: agentId, lid: lic.id });
                    toast.success("License removed");
                    void qc.invalidateQueries({ queryKey: getGetAgentLicensesQueryKey(agentId) });
                  } catch { toast.error("Failed to remove"); }
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add State License</DialogTitle></DialogHeader>
          <form onSubmit={handleAdd} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>State Code *</Label>
                <Input placeholder="TX" maxLength={2} value={form.stateCode} onChange={(e) => setForm(p => ({ ...p, stateCode: e.target.value.toUpperCase() }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm(p => ({ ...p, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["active", "pending", "expired", "suspended", "not_appointed"].map((s) => (
                      <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>License Type *</Label>
              <Input placeholder="Life & Health" value={form.licenseType} onChange={(e) => setForm(p => ({ ...p, licenseType: e.target.value }))} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>License Number</Label>
                <Input placeholder="12345678" value={form.licenseNumber} onChange={(e) => setForm(p => ({ ...p, licenseNumber: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Expiry Date</Label>
                <Input type="date" value={form.expiryDate} onChange={(e) => setForm(p => ({ ...p, expiryDate: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit">Add License</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CertificationsTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: certs, isLoading } = useGetAgentCertifications(agentId);
  const { data: carriers } = useGetCarriers();
  const { mutateAsync: createCert } = useCreateAgentCertification();
  const { mutateAsync: updateCert } = useUpdateAgentCertification();
  const [addOpen, setAddOpen] = useState(false);
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({ carrierId: "", certificationYear: String(currentYear), status: "not_started" as string });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createCert({ id: agentId, data: { carrierId: form.carrierId, certificationYear: parseInt(form.certificationYear, 10), status: form.status as "not_started" | "in_progress" | "passed" } });
      toast.success("Certification added");
      void qc.invalidateQueries({ queryKey: getGetAgentCertificationsQueryKey(agentId) });
      setAddOpen(false);
    } catch { toast.error("Failed to add certification"); }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{certs?.length ?? 0} certification{certs?.length !== 1 ? "s" : ""}</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Certification
        </Button>
      </div>

      {(certs ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Award className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No certifications recorded</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(certs ?? []).map((cert) => (
            <div key={cert.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{cert.carrierName}</p>
                <p className="text-xs text-muted-foreground">{cert.certificationYear}</p>
                {cert.score != null && <p className="text-xs text-muted-foreground">Score: {cert.score}%</p>}
              </div>
              <Select
                value={cert.status}
                onValueChange={async (v) => {
                  try {
                    await updateCert({ id: agentId, cid: cert.id, data: { status: v as "not_started" | "in_progress" | "passed" | "failed" | "waived" } });
                    void qc.invalidateQueries({ queryKey: getGetAgentCertificationsQueryKey(agentId) });
                  } catch { toast.error("Failed to update"); }
                }}
              >
                <SelectTrigger className="w-32 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["not_started", "in_progress", "passed", "failed", "waived"].map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">{s.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Carrier Certification</DialogTitle></DialogHeader>
          <form onSubmit={handleAdd} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Carrier *</Label>
              <Select value={form.carrierId} onValueChange={(v) => setForm(p => ({ ...p, carrierId: v }))}>
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
                <Label>Year *</Label>
                <Input type="number" value={form.certificationYear} onChange={(e) => setForm(p => ({ ...p, certificationYear: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm(p => ({ ...p, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["not_started", "in_progress", "passed", "failed", "waived"].map((s) => (
                      <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!form.carrierId}>Add Certification</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AhipTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: records, isLoading } = useGetAgentAhip(agentId);
  const { mutateAsync: createAhip } = useCreateAgentAhip();
  const { mutateAsync: updateAhip } = useUpdateAgentAhip();
  const [addOpen, setAddOpen] = useState(false);
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({ certificationYear: String(currentYear), status: "not_started" as string, score: "" });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createAhip({ id: agentId, data: { certificationYear: parseInt(form.certificationYear, 10), status: form.status as "not_started" | "in_progress" | "passed", score: form.score ? parseFloat(form.score) : undefined } });
      toast.success("AHIP record added");
      void qc.invalidateQueries({ queryKey: getGetAgentAhipQueryKey(agentId) });
      setAddOpen(false);
    } catch { toast.error("Failed to add AHIP record"); }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">AHIP Annual Medicare Certification</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Year
        </Button>
      </div>

      {(records ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ShieldCheck className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No AHIP records</p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...(records ?? [])].sort((a, b) => b.certificationYear - a.certificationYear).map((rec) => (
            <div key={rec.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{rec.certificationYear}</span>
                  {rec.certificationYear === currentYear && (
                    <Badge variant="secondary" className="text-[10px] bg-blue-100 text-blue-800">Current</Badge>
                  )}
                </div>
                {rec.score != null && <p className="text-xs text-muted-foreground">Score: {rec.score}%</p>}
                {rec.completedDate && <p className="text-xs text-muted-foreground">Completed {format(new Date(rec.completedDate), "MMM d, yyyy")}</p>}
              </div>
              <Select
                value={rec.status}
                onValueChange={async (v) => {
                  try {
                    await updateAhip({ id: agentId, aid: rec.id, data: { status: v as "not_started" | "in_progress" | "passed" | "failed" | "waived" } });
                    void qc.invalidateQueries({ queryKey: getGetAgentAhipQueryKey(agentId) });
                  } catch { toast.error("Failed to update"); }
                }}
              >
                <SelectTrigger className="w-32 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["not_started", "in_progress", "passed", "failed", "waived"].map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">{s.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add AHIP Record</DialogTitle></DialogHeader>
          <form onSubmit={handleAdd} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Year *</Label>
                <Input type="number" value={form.certificationYear} onChange={(e) => setForm(p => ({ ...p, certificationYear: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>Score (%)</Label>
                <Input type="number" min="0" max="100" placeholder="90" value={form.score} onChange={(e) => setForm(p => ({ ...p, score: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm(p => ({ ...p, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["not_started", "in_progress", "passed", "failed", "waived"].map((s) => (
                    <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit">Save Record</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChecklistTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: runs, isLoading } = useGetAgentChecklists(agentId);
  const { mutateAsync: updateItem } = useUpdateChecklistItem();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const activeRun = selectedRunId ?? (runs?.[0]?.id ?? null);

  const { data: runDetail } = useGetAgentChecklist(agentId, activeRun ?? "", {
    query: { enabled: !!activeRun, queryKey: ["getAgentChecklist", agentId, activeRun ?? ""] },
  });

  const handleItemUpdate = async (runId: string, itemId: string, status: "completed" | "skipped" | "pending") => {
    try {
      await updateItem({ runId, itemId, data: { status } });
      void qc.invalidateQueries({ queryKey: getGetAgentChecklistQueryKey(agentId, runId) });
    } catch { toast.error("Failed to update item"); }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  if ((runs ?? []).length === 0) {
    return (
      <div className="p-6 text-center py-12 text-muted-foreground">
        <CheckSquare className="h-10 w-10 mx-auto mb-2 opacity-20" />
        <p className="text-sm">No checklists found</p>
        <p className="text-xs mt-1">An onboarding checklist is created automatically when an agent is added</p>
      </div>
    );
  }

  const items = runDetail?.items ?? [];
  const completedCount = items.filter((i) => i.status === "completed").length;
  const totalCount = items.length;

  return (
    <div className="p-6 space-y-4">
      {(runs ?? []).length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {(runs ?? []).map((run) => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={cn(
                "text-xs px-3 py-1.5 rounded-full border transition-colors capitalize",
                (activeRun === run.id)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              {run.type} · {run.status}
            </button>
          ))}
        </div>
      )}

      {runDetail && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold capitalize">{runDetail.type} Checklist</p>
              <p className="text-xs text-muted-foreground">{completedCount}/{totalCount} items complete</p>
            </div>
            <Badge
              variant="secondary"
              className={runDetail.status === "completed" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}
            >
              {runDetail.status === "completed" ? "Complete" : "In Progress"}
            </Badge>
          </div>
          <Progress value={totalCount > 0 ? (completedCount / totalCount) * 100 : 0} className="h-1.5" />
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
                  item.status === "completed" ? "border-green-200 bg-green-50/50" :
                  item.status === "skipped" ? "border-slate-200 bg-slate-50/50 opacity-60" :
                  "border-border"
                )}
              >
                <div className={cn(
                  "mt-0.5 flex-shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center",
                  item.status === "completed" ? "bg-green-500 border-green-500 text-white" :
                  item.status === "skipped" ? "bg-slate-200 border-slate-200" :
                  "border-muted-foreground/30"
                )}>
                  {item.status === "completed" && <Check className="h-3 w-3" />}
                  {item.status === "skipped" && <SkipForward className="h-3 w-3 text-slate-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-sm", item.status === "completed" && "line-through text-muted-foreground")}>
                    {item.title}
                    {item.required && item.status !== "completed" && (
                      <span className="ml-1 text-xs text-red-500">*</span>
                    )}
                  </p>
                  {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
                </div>
                {runDetail.status !== "completed" && item.status === "pending" && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs text-green-700 border-green-200 hover:bg-green-50"
                      onClick={() => handleItemUpdate(runDetail.id, item.id, "completed")}
                    >
                      <Check className="h-3 w-3 mr-1" />Done
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => handleItemUpdate(runDetail.id, item.id, "skipped")}
                    >
                      Skip
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TechStackTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: accounts, isLoading } = useGetAgentTechStack(agentId);
  const { mutateAsync: createAccount } = useCreateAgentTechStackAccount();
  const { mutateAsync: updateAccount } = useUpdateAgentTechStackAccount();
  const { mutateAsync: bulkUpdate, isPending: bulkPending } = useBulkUpdateAgentTechStack();
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ platformName: "", platformCategory: "", status: "pending" as string, accountIdentifier: "" });

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleBulkUpdate = async (status: "provisioned" | "pending" | "deprovisioned") => {
    if (selected.size === 0) return;
    try {
      await bulkUpdate({ id: agentId, data: { accountIds: [...selected], status } });
      toast.success(`Updated ${selected.size} account${selected.size !== 1 ? "s" : ""} to ${status}`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: getGetAgentTechStackQueryKey(agentId) });
    } catch { toast.error("Bulk update failed"); }
  };

  const handleExportPdf = () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    window.open(`${base}/api/agents/${agentId}/tech-stack/pdf`, "_blank");
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">{accounts?.length ?? 0} platform{accounts?.length !== 1 ? "s" : ""}</p>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">{selected.size} selected</span>
              <Select onValueChange={(v) => handleBulkUpdate(v as "provisioned" | "pending" | "deprovisioned")} disabled={bulkPending}>
                <SelectTrigger className="h-7 text-xs w-40">
                  <SelectValue placeholder="Bulk set status…" />
                </SelectTrigger>
                <SelectContent>
                  {["provisioned", "pending", "deprovisioned"].map((s) => (
                    <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          <Button size="sm" variant="outline" onClick={handleExportPdf}>
            <FileDown className="h-3.5 w-3.5 mr-1.5" />
            Export PDF
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Platform
          </Button>
        </div>
      </div>

      {(accounts ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Monitor className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No tech stack accounts</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(accounts ?? []).map((acct) => (
            <div
              key={acct.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors cursor-pointer",
                selected.has(acct.id) ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
              )}
              onClick={() => toggleSelect(acct.id)}
            >
              <input
                type="checkbox"
                checked={selected.has(acct.id)}
                onChange={() => toggleSelect(acct.id)}
                onClick={(e) => e.stopPropagation()}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{acct.platformName}</p>
                {acct.platformCategory && <p className="text-xs text-muted-foreground capitalize">{acct.platformCategory}</p>}
                {acct.accountIdentifier && <p className="text-xs text-muted-foreground font-mono mt-0.5">{acct.accountIdentifier}</p>}
              </div>
              <Select
                value={acct.status}
                onValueChange={async (v) => {
                  try {
                    await updateAccount({ id: agentId, aid: acct.id, data: { status: v as "provisioned" | "pending" | "deprovisioned" } });
                    void qc.invalidateQueries({ queryKey: getGetAgentTechStackQueryKey(agentId) });
                  } catch { toast.error("Failed to update"); }
                }}
              >
                <SelectTrigger className="w-36 h-7 text-xs" onClick={(e) => e.stopPropagation()}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["provisioned", "pending", "deprovisioned"].map((s) => (
                    <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Platform Account</DialogTitle></DialogHeader>
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              await createAccount({ id: agentId, data: { platformName: form.platformName, platformCategory: form.platformCategory || undefined, status: form.status as "provisioned" | "pending", accountIdentifier: form.accountIdentifier || undefined } });
              toast.success("Account added");
              void qc.invalidateQueries({ queryKey: getGetAgentTechStackQueryKey(agentId) });
              setAddOpen(false);
            } catch { toast.error("Failed to add account"); }
          }} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Platform Name *</Label>
              <Input placeholder="GoHighLevel" value={form.platformName} onChange={(e) => setForm(p => ({ ...p, platformName: e.target.value }))} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Input placeholder="CRM" value={form.platformCategory} onChange={(e) => setForm(p => ({ ...p, platformCategory: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm(p => ({ ...p, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["provisioned", "pending", "deprovisioned"].map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Account ID / Username</Label>
              <Input placeholder="jane@agency.com" value={form.accountIdentifier} onChange={(e) => setForm(p => ({ ...p, accountIdentifier: e.target.value }))} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!form.platformName}>Add Platform</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TasksTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: tasks, isLoading } = useGetAgentTasks(agentId);
  const { mutateAsync: createTask, isPending: creating } = useCreateTask();

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    description: string;
    dueDate: string;
    priority: "low" | "medium" | "high" | "urgent";
  }>({ title: "", description: "", dueDate: "", priority: "medium" });

  const PRIORITY_STYLES: Record<string, string> = {
    urgent: "bg-red-100 text-red-800",
    high: "bg-orange-100 text-orange-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-slate-100 text-slate-600",
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    try {
      await createTask({
        data: {
          agentId,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          dueDate: form.dueDate || undefined,
          priority: form.priority,
        },
      });
      toast.success("Task assigned to agent");
      void qc.invalidateQueries({ queryKey: getGetAgentTasksQueryKey(agentId) });
      void qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      void qc.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      setForm({ title: "", description: "", dueDate: "", priority: "medium" });
      setAddOpen(false);
    } catch {
      toast.error("Failed to assign task");
    }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{tasks?.length ?? 0} task{tasks?.length !== 1 ? "s" : ""}</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New task
        </Button>
      </div>
      {(tasks ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CheckSquare className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No tasks assigned</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(tasks ?? []).map((task) => (
            <div key={task.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{task.title}</p>
                {task.dueDate && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Due {format(new Date(task.dueDate), "MMM d, yyyy")}
                  </p>
                )}
              </div>
              <Badge variant="secondary" className={`text-xs ${PRIORITY_STYLES[task.priority] ?? ""}`}>
                {task.priority}
              </Badge>
              <Badge variant="secondary" className="text-xs capitalize">
                {task.status.replace("_", " ")}
              </Badge>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign task to this agent</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="e.g. Renew Texas Health license"
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-desc">Description</Label>
              <Input
                id="task-desc"
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Optional details"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-priority">Priority</Label>
                <Select
                  value={form.priority}
                  onValueChange={(v) =>
                    setForm((p) => ({ ...p, priority: v as typeof form.priority }))
                  }
                >
                  <SelectTrigger id="task-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !form.title.trim()}>
                {creating ? "Assigning…" : "Assign task"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const { data, isLoading } = useGetAuditLog({ limit: 100 });

  const entries = (data?.entries ?? []).filter(
    (e) =>
      e.resourceId === agentId ||
      (e.changes && typeof e.changes === "object" && "agentId" in e.changes && (e.changes as Record<string, unknown>).agentId === agentId)
  );

  const ACTION_STYLES: Record<string, string> = {
    create: "bg-green-100 text-green-800",
    update: "bg-blue-100 text-blue-800",
    delete: "bg-red-100 text-red-800",
    offboard: "bg-orange-100 text-orange-800",
    complete: "bg-green-100 text-green-800",
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">{entries.length} event{entries.length !== 1 ? "s" : ""}</p>
      {entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No activity recorded</p>
        </div>
      ) : (
        <div className="relative border-l-2 border-border ml-3 space-y-0">
          {entries.map((entry) => {
            const actionKey = entry.action?.split(".").pop() ?? entry.action ?? "";
            const badgeStyle = ACTION_STYLES[actionKey] ?? "bg-slate-100 text-slate-600";
            return (
              <div key={entry.id} className="relative pl-6 pb-5 last:pb-0">
                <span className="absolute -left-1.5 top-1.5 h-3 w-3 rounded-full bg-border border-2 border-background" />
                <div className="flex items-start gap-2 flex-wrap">
                  <Badge variant="secondary" className={cn("text-[10px] px-1.5 py-0 capitalize", badgeStyle)}>
                    {entry.action}
                  </Badge>
                  {entry.resourceType && (
                    <span className="text-xs text-muted-foreground capitalize">{entry.resourceType.replace(/_/g, " ")}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {format(new Date(entry.createdAt), "MMM d, yyyy 'at' h:mm a")}
                  {entry.userId && <span className="ml-2">· by user</span>}
                </p>
                {entry.changes && Object.keys(entry.changes).length > 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                    {JSON.stringify(entry.changes).slice(0, 120)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DocumentsTab({ agentId }: { agentId: string }) {
  const { data: docs, isLoading } = useGetAgentDocuments(agentId);

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">{docs?.length ?? 0} document{docs?.length !== 1 ? "s" : ""}</p>
      {(docs ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FolderOpen className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No documents</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(docs ?? []).map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{doc.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{doc.category} · {format(new Date(doc.createdAt), "MMM d, yyyy")}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentProfilePage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id ?? "";
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [offboardConfirm, setOffboardConfirm] = useState(false);

  const { data: agent, isLoading } = useGetAgent(agentId);
  const { mutateAsync: updateAgent } = useUpdateAgent();
  const { mutateAsync: offboard, isPending: offboarding } = useOffboardAgent();
  const { data: offboardingReport } = useGetAgentOffboardingReport(agentId);

  const handleOffboard = async () => {
    try {
      await offboard({ id: agentId });
      toast.success("Offboarding initiated — checklist created");
      void qc.invalidateQueries({ queryKey: getGetAgentQueryKey(agentId) });
      setOffboardConfirm(false);
    } catch { toast.error("Failed to start offboarding"); }
  };

  const handleStatusChange = async (newStatus: string) => {
    try {
      await updateAgent({ id: agentId, data: { status: newStatus as "onboarding" | "active" | "suspended" | "offboarding" | "offboarded" } });
      void qc.invalidateQueries({ queryKey: getGetAgentQueryKey(agentId) });
      toast.success("Status updated");
    } catch { toast.error("Failed to update status"); }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Agent not found</p>
        <Button variant="link" onClick={() => navigate("/agents")}>Back to Agents</Button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="p-6 pb-0 space-y-5">
        <Button variant="ghost" size="sm" className="-ml-1 text-muted-foreground" onClick={() => navigate("/agents")}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Agents
        </Button>

        <div className="flex items-start gap-4">
          <Avatar className="h-16 w-16 shrink-0">
            <AvatarImage src={agent.avatarUrl ?? undefined} />
            <AvatarFallback className="text-xl bg-primary/10 text-primary">
              {agent.firstName[0]}{agent.lastName[0]}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3 flex-wrap">
              <div>
                <h1 className="text-xl font-bold">{agent.firstName} {agent.lastName}</h1>
                <p className="text-sm text-muted-foreground">{agent.email}</p>
                {agent.phone && <p className="text-sm text-muted-foreground">{agent.phone}</p>}
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Badge
                  variant="secondary"
                  className={`capitalize border ${STATUS_STYLES[agent.status] ?? ""}`}
                >
                  {agent.status}
                </Badge>
                {agent.npn && (
                  <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                    NPN {agent.npn}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            {offboardingReport && (
              <Button
                variant="outline"
                size="sm"
                asChild
              >
                <a
                  href={`${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/agents/${agentId}/offboarding-report/download`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileDown className="h-3.5 w-3.5 mr-1.5" />
                  Offboarding Report
                </a>
              </Button>
            )}
            {agent.status !== "offboarded" && agent.status !== "offboarding" && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/30 hover:bg-destructive/5"
                onClick={() => setOffboardConfirm(true)}
              >
                Offboard
              </Button>
            )}
            <Select value={agent.status} onValueChange={handleStatusChange}>
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["onboarding", "active", "suspended", "offboarding", "offboarded"].map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-border pb-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        {activeTab === "overview" && <OverviewTab agentId={agentId} />}
        {activeTab === "licenses" && <LicensesTab agentId={agentId} />}
        {activeTab === "certifications" && <CertificationsTab agentId={agentId} />}
        {activeTab === "ahip" && <AhipTab agentId={agentId} />}
        {activeTab === "checklist" && <ChecklistTab agentId={agentId} />}
        {activeTab === "techstack" && <TechStackTab agentId={agentId} />}
        {activeTab === "tasks" && <TasksTab agentId={agentId} />}
        {activeTab === "documents" && <DocumentsTab agentId={agentId} />}
        {activeTab === "activity" && <ActivityTab agentId={agentId} />}
      </div>

      <AlertDialog open={offboardConfirm} onOpenChange={setOffboardConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Offboard {agent.firstName} {agent.lastName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will set the agent status to Offboarding and automatically create an offboarding checklist. This action can be reviewed and reversed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleOffboard}
              disabled={offboarding}
            >
              {offboarding ? "Starting…" : "Start Offboarding"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
