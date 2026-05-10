import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  PipelineWithStages, PipelineStage,
  GetDeals200Item,
  CreateDealBody, CreatePipelineBody, UpdateDealBody,
} from "@workspace/api-client-react";
import {
  useGetPipelines, useCreatePipeline, useGetDeals, useCreateDeal, useUpdateDeal,
  useGetPipelineAnalytics,
  getGetPipelinesQueryKey, getGetDealsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, TrendingUp, DollarSign } from "lucide-react";
import { toast } from "sonner";

export default function PipelineTab() {
  const qc = useQueryClient();
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [addDealOpen, setAddDealOpen] = useState(false);
  const [addPipelineOpen, setAddPipelineOpen] = useState(false);
  const [dealForm, setDealForm] = useState<CreateDealBody>({ pipelineId: "", stageId: "", contactId: "", title: "", valueEst: null });
  const [pipelineForm, setPipelineForm] = useState<Pick<CreatePipelineBody, "name" | "description">>({ name: "", description: "" });

  const { data: pipelines, isLoading: pipelinesLoading } = useGetPipelines();
  const pipelineList: PipelineWithStages[] = pipelines ?? [];
  const activePipeline: PipelineWithStages | undefined = selectedPipelineId
    ? pipelineList.find((p) => p.id === selectedPipelineId)
    : pipelineList[0];

  const { data: dealsRaw, isLoading: dealsLoading } = useGetDeals({
    pipelineId: activePipeline?.id,
    limit: 500,
  });
  const { data: analytics } = useGetPipelineAnalytics(activePipeline?.id ?? "", {
    query: { enabled: !!activePipeline?.id, queryKey: ["pipeline-analytics", activePipeline?.id ?? ""] },
  });

  const { mutateAsync: createDeal } = useCreateDeal();
  const { mutateAsync: updateDeal } = useUpdateDeal();
  const { mutateAsync: createPipeline, isPending: creatingPipeline } = useCreatePipeline();

  const stages: PipelineStage[] = activePipeline?.stages ?? [];
  const deals: GetDeals200Item[] = dealsRaw ?? [];

  const handleCreateDeal = async () => {
    if (!dealForm.contactId || !dealForm.title || !dealForm.stageId || !dealForm.pipelineId) {
      toast.error("Pipeline, contact, title, and stage are required"); return;
    }
    try {
      await createDeal({ data: dealForm });
      toast.success("Deal created");
      setAddDealOpen(false);
      void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
    } catch { toast.error("Failed to create deal"); }
  };

  const handleCreatePipeline = async () => {
    if (!pipelineForm.name) { toast.error("Pipeline name required"); return; }
    try {
      const p = await createPipeline({
        data: {
          ...pipelineForm,
          stages: [
            { name: "New Lead", color: "#6366f1", probabilityPct: 10 },
            { name: "Contacted", color: "#f59e0b", probabilityPct: 30 },
            { name: "Qualified", color: "#8b5cf6", probabilityPct: 50 },
            { name: "Application", color: "#ec4899", probabilityPct: 70 },
            { name: "Enrolled", color: "#10b981", probabilityPct: 90 },
          ],
        },
      });
      toast.success("Pipeline created");
      setAddPipelineOpen(false);
      setPipelineForm({ name: "", description: "" });
      setSelectedPipelineId((p as { id: string }).id);
      void qc.invalidateQueries({ queryKey: getGetPipelinesQueryKey() });
    } catch { toast.error("Failed to create pipeline"); }
  };

  const moveStage = async (dealId: string, stageId: string) => {
    await updateDeal({ id: dealId, data: { stageId } satisfies UpdateDealBody });
    void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
  };

  if (pipelinesLoading) return <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>;

  if (pipelineList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <TrendingUp className="h-12 w-12 text-muted-foreground/20 mb-3" />
        <p className="font-medium text-muted-foreground">No pipelines yet</p>
        <p className="text-sm text-muted-foreground/70 mt-1 mb-4">Create your first sales pipeline to track deals</p>
        <Button size="sm" onClick={() => setAddPipelineOpen(true)}><Plus className="h-4 w-4 mr-1" />Create Pipeline</Button>
        <CreatePipelineDialog open={addPipelineOpen} onOpenChange={setAddPipelineOpen} form={pipelineForm} setForm={setPipelineForm} onSubmit={handleCreatePipeline} isPending={creatingPipeline} />
      </div>
    );
  }

  const pipelineAnalytics = analytics as
    | {
        totalDeals?: number;
        wonDeals?: number;
        lostDeals?: number;
        openDeals?: number;
        conversionRate?: number;
        openValueTotal?: number;
        wonValueTotal?: number;
        lostValueTotal?: number;
      }
    | undefined;

  const fmtCurrency = (n: number) => `$${Math.round(n).toLocaleString()}`;

  const closeDeal = async (
    dealId: string,
    status: "won" | "lost",
    lostReason?: string,
  ) => {
    try {
      await updateDeal({
        id: dealId,
        data: { status, ...(status === "lost" ? { lostReason: lostReason ?? null } : {}) } satisfies UpdateDealBody,
      });
      toast.success(status === "won" ? "Deal marked as won" : "Deal marked as lost");
      void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
      void qc.invalidateQueries({ queryKey: ["pipeline-analytics", activePipeline?.id ?? ""] });
    } catch {
      toast.error(`Failed to mark deal as ${status}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={activePipeline?.id ?? ""} onValueChange={setSelectedPipelineId}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {pipelineList.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setAddPipelineOpen(true)}><Plus className="h-4 w-4 mr-1" />New Pipeline</Button>
        <div className="flex-1" />
        <Button size="sm" onClick={() => {
          setDealForm((f) => ({ ...f, pipelineId: activePipeline?.id ?? "" }));
          setAddDealOpen(true);
        }}><Plus className="h-4 w-4 mr-1" />New Deal</Button>
      </div>

      {pipelineAnalytics && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold">{pipelineAnalytics.totalDeals ?? 0}</p>
            <p className="text-xs text-muted-foreground">Total Deals</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold tabular-nums">{fmtCurrency(pipelineAnalytics.openValueTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">Open Pipeline</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold text-green-700 tabular-nums">{fmtCurrency(pipelineAnalytics.wonValueTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">Won ({pipelineAnalytics.wonDeals ?? 0})</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold text-red-700 tabular-nums">{fmtCurrency(pipelineAnalytics.lostValueTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">Lost ({pipelineAnalytics.lostDeals ?? 0})</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold">{pipelineAnalytics.conversionRate ?? 0}%</p>
            <p className="text-xs text-muted-foreground">Conv. Rate</p>
          </CardContent></Card>
        </div>
      )}

      {dealsLoading ? <Skeleton className="h-64 w-full rounded-xl" /> : (
        <ScrollArea className="w-full">
          <div className="flex gap-4 pb-4 min-w-max">
            {stages.map((stage) => {
              const stageDeals = deals.filter((rowRaw) => {
                const row = rowRaw as Record<string, unknown>;
                const deal = row.deal as Record<string, unknown> | undefined;
                // Only count open deals in stage columns — won/lost get their
                // own pipeline-level totals shown in the stat cards above.
                return deal?.stageId === stage.id && deal?.status === "open";
              });
              // Real-time per-stage value rolls up from the deals list, so the
              // total updates immediately on stage moves / won/lost without
              // waiting for the analytics refetch.
              const stageValueTotal = stageDeals.reduce((sum, rowRaw) => {
                const deal = (rowRaw as Record<string, unknown>).deal as
                  | Record<string, unknown>
                  | undefined;
                return sum + (Number(deal?.valueEst ?? 0) || 0);
              }, 0);
              return (
                <div key={stage.id} className="w-72 flex-shrink-0">
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                    <span className="font-medium text-sm">{stage.name}</span>
                    <Badge variant="secondary" className="ml-auto text-xs">{stageDeals.length}</Badge>
                  </div>
                  <div className="px-1 mb-2 text-[11px] text-muted-foreground tabular-nums">
                    {stageValueTotal > 0 ? fmtCurrency(stageValueTotal) : "—"}
                  </div>
                  <div className="space-y-2 bg-muted/30 rounded-xl p-2 min-h-[120px]">
                    {stageDeals.map((rowRaw) => {
                      const row = rowRaw as Record<string, unknown>;
                      const deal = row.deal as Record<string, unknown> | undefined;
                      if (!deal) return null;
                      return (
                        <div key={String(deal.id)} className="bg-card rounded-lg border p-3 shadow-sm hover:shadow-md transition-shadow">
                          <p className="font-medium text-sm leading-tight truncate">{String(deal.title)}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{String(row.contactFirstName ?? "")} {String(row.contactLastName ?? "")}</p>
                          <div className="flex items-center gap-2 mt-2">
                            {deal.valueEst != null && <span className="text-xs font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded"><DollarSign className="h-2.5 w-2.5 inline mr-0.5" />{Number(deal.valueEst).toLocaleString()}</span>}
                            <Select value={String(deal.stageId)} onValueChange={(v) => moveStage(String(deal.id), v)}>
                              <SelectTrigger className="h-6 w-28 text-xs ml-auto"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex gap-1.5 mt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px] flex-1 text-green-700 border-green-200 hover:bg-green-50"
                              onClick={() => closeDeal(String(deal.id), "won")}
                            >
                              Won
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px] flex-1 text-red-700 border-red-200 hover:bg-red-50"
                              onClick={() => {
                                const reason = window.prompt("Reason for losing this deal? (optional)") ?? undefined;
                                void closeDeal(String(deal.id), "lost", reason);
                              }}
                            >
                              Lost
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    {stageDeals.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No deals</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {/* Add Deal Dialog */}
      <Dialog open={addDealOpen} onOpenChange={setAddDealOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Deal</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5"><Label>Contact ID *</Label><Input value={dealForm.contactId} onChange={(e) => setDealForm((f) => ({ ...f, contactId: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>Deal Title *</Label><Input value={dealForm.title} onChange={(e) => setDealForm((f) => ({ ...f, title: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Stage *</Label>
                <Select value={dealForm.stageId} onValueChange={(v) => setDealForm((f) => ({ ...f, stageId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label>Est. Value ($)</Label><Input type="number" value={dealForm.valueEst ?? ""} onChange={(e) => setDealForm((f) => ({ ...f, valueEst: e.target.value ? parseFloat(e.target.value) : null }))} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDealOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateDeal}>Create Deal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreatePipelineDialog open={addPipelineOpen} onOpenChange={setAddPipelineOpen} form={pipelineForm} setForm={setPipelineForm} onSubmit={handleCreatePipeline} isPending={creatingPipeline} />
    </div>
  );
}

function CreatePipelineDialog({
  open, onOpenChange, form, setForm, onSubmit, isPending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  form: { name: string; description?: string | null };
  setForm: (fn: (f: { name: string; description?: string | null }) => { name: string; description?: string | null }) => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>New Pipeline</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5"><Label>Name *</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label>Description</Label><Input value={form.description ?? ""} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || null }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSubmit} disabled={isPending}>{isPending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
