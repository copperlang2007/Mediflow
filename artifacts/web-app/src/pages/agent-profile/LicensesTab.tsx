import { useState } from "react";
import {
  useGetAgentLicenses,
  useCreateAgentLicense,
  useUpdateAgentLicense,
  useDeleteAgentLicense,
  useRequestUploadUrl,
  getGetAgentLicensesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { FileText, Upload, Link, Plus, X } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { LICENSE_STATUS_STYLES } from "./shared";
import { EmptyState, StatusPill } from "@/components/shared";

export default function LicensesTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: licensesData, isLoading } = useGetAgentLicenses(agentId);
  const licenses = licensesData?.data;
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
        <EmptyState compact icon={FileText} title="No licenses yet" description="Add the state licenses this agent holds so you can see where they can sell and when each one expires." />
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
              <StatusPill status={lic.status} tone={lic.status === "not_appointed" ? "neutral" : undefined} />
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
