import { useState } from "react";
import {
  useGetAgentAhip,
  useCreateAgentAhip,
  useUpdateAgentAhip,
  getGetAgentAhipQueryKey,
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
import { ShieldCheck, Plus } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared";
import { sellingPlanYear } from "@/lib/planYear";

export default function AhipTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: records, isLoading } = useGetAgentAhip(agentId);
  const { mutateAsync: createAhip } = useCreateAgentAhip();
  const { mutateAsync: updateAhip } = useUpdateAgentAhip();
  const [addOpen, setAddOpen] = useState(false);
  const currentYear = sellingPlanYear();
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
        <EmptyState compact icon={ShieldCheck} title="No AHIP records yet" description="AHIP is the yearly Medicare training agents need before selling. Add this year's completion when it's done." />
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
