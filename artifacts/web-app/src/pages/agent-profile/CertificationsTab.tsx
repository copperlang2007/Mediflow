import { useState } from "react";
import {
  useGetAgentCertifications,
  useCreateAgentCertification,
  useUpdateAgentCertification,
  useGetCarriers,
  getGetAgentCertificationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Award, Plus } from "lucide-react";
import { toast } from "sonner";

export default function CertificationsTab({ agentId }: { agentId: string }) {
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
