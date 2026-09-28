import { useState } from "react";
import {
  useGetAgentTechStack,
  useCreateAgentTechStackAccount,
  useUpdateAgentTechStackAccount,
  useBulkUpdateAgentTechStack,
  getGetAgentTechStackQueryKey,
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
import { Monitor, Plus, FileDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/shared";

export default function TechStackTab({ agentId }: { agentId: string }) {
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
        <EmptyState compact icon={Monitor} title="No tool accounts yet" description="Track the logins this agent has been given — dialer, quoting, email — so nothing is missed when they join or leave." />
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
