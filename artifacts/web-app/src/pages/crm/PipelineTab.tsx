import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type {
  PipelineWithStages, PipelineStage,
  GetDeals200Item,
  CreateDealBody, CreatePipelineBody, UpdateDealBody,
} from "@workspace/api-client-react";
import {
  useGetPipelines, useCreatePipeline, useGetDeals, useCreateDeal, useUpdateDeal, useGetContacts,
  useGetPipelineAnalytics,
  getGetPipelinesQueryKey, getGetDealsQueryKey, getGetContactsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Plus, TrendingUp, DollarSign, Gauge, Trophy, Percent, MoreHorizontal, CheckCircle2, XCircle, Info,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { EmptyState, KpiCard, SectionCard, StatusPill } from "@/components/shared";
import { cn } from "@/lib/utils";

/** Shape of one row from GET /deals (the generated type is untyped). */
type DealRow = {
  deal: {
    id: string;
    stageId: string;
    contactId: string;
    title: string;
    valueEst: number | null;
    status: "open" | "won" | "lost";
    lostReason: string | null;
    wonAt: string | null;
    lostAt: string | null;
    updatedAt: string;
    createdAt: string;
  };
  contactFirstName: string | null;
  contactLastName: string | null;
};

/**
 * A pipeline's last stage usually *is* the finish line ("Enrolled"). When it
 * is, won deals are shown in that column so "Won (2)" and the Enrolled column
 * always agree. Otherwise won deals get their own "Won" column at the end.
 */
const FINISH_STAGE = /enrol|won|closed|sold|complete|issued/i;

const fmtCurrency = (n: number) => `$${Math.round(n).toLocaleString()}`;

function contactName(row: DealRow) {
  return [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ") || "Unnamed contact";
}

export default function PipelineTab() {
  const qc = useQueryClient();
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [addDealOpen, setAddDealOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedContactLabel, setSelectedContactLabel] = useState("");
  const [addPipelineOpen, setAddPipelineOpen] = useState(false);
  const [dealForm, setDealForm] = useState<CreateDealBody>({ pipelineId: "", stageId: "", contactId: "", title: "", valueEst: null });
  const [pipelineForm, setPipelineForm] = useState<Pick<CreatePipelineBody, "name" | "description">>({ name: "", description: "" });
  const [lostTarget, setLostTarget] = useState<DealRow | null>(null);
  const [lostReason, setLostReason] = useState("");

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

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(contactSearch), 300);
    return () => window.clearTimeout(timer);
  }, [contactSearch]);

  const { data: contactsData, isLoading: contactsLoading } = useGetContacts(
    { search: debouncedSearch || undefined, limit: 100 },
    { query: { enabled: addDealOpen, queryKey: getGetContactsQueryKey({ search: debouncedSearch || undefined, limit: 100 }) } },
  );
  const { mutateAsync: createDeal } = useCreateDeal();
  const { mutateAsync: updateDeal } = useUpdateDeal();
  const { mutateAsync: createPipeline, isPending: creatingPipeline } = useCreatePipeline();

  const stages: PipelineStage[] = useMemo(
    () => [...(activePipeline?.stages ?? [])].sort((a, b) => a.orderIndex - b.orderIndex),
    [activePipeline],
  );
  const deals = useMemo(
    () => ((dealsRaw ?? []) as GetDeals200Item[]).filter((r) => (r as Record<string, unknown>).deal) as unknown as DealRow[],
    [dealsRaw],
  );
  const openDeals = deals.filter((r) => r.deal.status === "open");
  const wonDeals = deals.filter((r) => r.deal.status === "won");
  const lostDeals = deals.filter((r) => r.deal.status === "lost");

  const lastStage = stages[stages.length - 1];
  const finishStageId = lastStage && FINISH_STAGE.test(lastStage.name) ? lastStage.id : null;

  const onDealOpenChange = (open: boolean) => {
    setAddDealOpen(open);
    if (!open) {
      setContactSearch("");
      setDebouncedSearch("");
      setSelectedContactLabel("");
      setDealForm({ pipelineId: "", stageId: "", contactId: "", title: "", valueEst: null });
    }
  };

  const handleCreateDeal = async () => {
    if (!dealForm.contactId || !dealForm.title || !dealForm.stageId || !dealForm.pipelineId) {
      toast.error("Pipeline, contact, title, and stage are required"); return;
    }
    try {
      await createDeal({ data: dealForm });
      toast.success("Deal created");
      onDealOpenChange(false);
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
    try {
      await updateDeal({ id: dealId, data: { stageId } satisfies UpdateDealBody });
      const stageName = stages.find((s) => s.id === stageId)?.name;
      toast.success(stageName ? `Moved to ${stageName}` : "Deal moved");
    } catch {
      toast.error("Could not move the deal");
    }
    void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
    void qc.invalidateQueries({ queryKey: ["pipeline-analytics", activePipeline?.id ?? ""] });
  };

  const closeDeal = async (
    dealId: string,
    status: "won" | "lost",
    reason?: string,
  ) => {
    try {
      await updateDeal({
        id: dealId,
        data: { status, ...(status === "lost" ? { lostReason: reason ?? null } : {}) } satisfies UpdateDealBody,
      });
      toast.success(status === "won" ? "Deal marked as won" : "Deal marked as lost");
      void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
      void qc.invalidateQueries({ queryKey: ["pipeline-analytics", activePipeline?.id ?? ""] });
    } catch {
      toast.error(`Failed to mark deal as ${status}`);
    }
  };

  const confirmLost = async () => {
    if (!lostTarget) return;
    await closeDeal(lostTarget.deal.id, "lost", lostReason.trim() || undefined);
    setLostTarget(null);
    setLostReason("");
  };

  if (pipelinesLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (pipelineList.length === 0) {
    return (
      <SectionCard>
        <EmptyState
          icon={TrendingUp}
          title="No sales pipeline yet"
          description="A pipeline shows every deal as a card moving from first contact to enrolled. Create one to start tracking your sales."
          action={{ label: "Create a pipeline", onClick: () => setAddPipelineOpen(true) }}
        />
        <CreatePipelineDialog open={addPipelineOpen} onOpenChange={setAddPipelineOpen} form={pipelineForm} setForm={setPipelineForm} onSubmit={handleCreatePipeline} isPending={creatingPipeline} />
      </SectionCard>
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

  // Weighted forecast = each open deal's value × its stage's win probability.
  const stageProbability = new Map(stages.map((s) => [s.id, s.probabilityPct ?? 0]));
  const weightedForecast = openDeals.reduce(
    (sum, r) => sum + (Number(r.deal.valueEst ?? 0) || 0) * ((stageProbability.get(r.deal.stageId) ?? 0) / 100),
    0,
  );
  const sumValue = (rows: DealRow[]) => rows.reduce((s, r) => s + (Number(r.deal.valueEst ?? 0) || 0), 0);

  type Column = { key: string; name: string; color: string; stage?: PipelineStage; open: DealRow[]; won: DealRow[] };
  const columns: Column[] = stages.map((stage) => ({
    key: stage.id,
    name: stage.name,
    color: stage.color,
    stage,
    open: openDeals.filter((r) => r.deal.stageId === stage.id),
    won: stage.id === finishStageId ? wonDeals : [],
  }));
  if (!finishStageId) {
    columns.push({ key: "__won", name: "Won", color: "#16a34a", open: [], won: wonDeals });
  }

  const renderOpenCard = (row: DealRow, isFinish: boolean) => {
    const { deal } = row;
    const prob = stageProbability.get(deal.stageId) ?? 0;
    return (
      <div key={deal.id} className="rounded-lg border border-border bg-card p-3 shadow-sm hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between gap-2">
          <Link href={`/crm/contacts/${deal.contactId}`} className="min-w-0 font-medium text-sm leading-tight hover:underline truncate">
            {contactName(row)}
          </Link>
          {deal.valueEst != null && (
            <span className="shrink-0 text-sm font-semibold text-success tabular-nums">{fmtCurrency(Number(deal.valueEst))}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground truncate" title={deal.title}>{deal.title}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden" aria-hidden>
            <div className="h-full rounded-full bg-navy-600 dark:bg-accent" style={{ width: `${Math.min(100, Math.max(0, prob))}%` }} />
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap" title="Chance of closing at this stage">{prob}%</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground truncate">
            Updated {formatDistanceToNow(new Date(deal.updatedAt), { addSuffix: true })}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`Actions for ${contactName(row)}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Move to stage</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={deal.stageId} onValueChange={(v) => { if (v !== deal.stageId) void moveStage(deal.id, v); }}>
                {stages.map((s) => (
                  <DropdownMenuRadioItem key={s.id} value={s.id}>{s.name}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void closeDeal(deal.id, "won")}>
                <CheckCircle2 className="h-4 w-4 mr-2 text-success" />Mark as won
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setLostReason(""); setLostTarget(row); }}>
                <XCircle className="h-4 w-4 mr-2 text-destructive" />Mark as lost…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {isFinish && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7 w-full text-xs text-success border-success/30 hover:bg-success/10 hover:text-success"
            onClick={() => void closeDeal(deal.id, "won")}
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />Confirm enrolled — mark won
          </Button>
        )}
      </div>
    );
  };

  const renderWonCard = (row: DealRow) => (
    <div key={row.deal.id} className="rounded-lg border border-success/30 bg-success/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/crm/contacts/${row.deal.contactId}`} className="min-w-0 font-medium text-sm leading-tight hover:underline truncate">
          {contactName(row)}
        </Link>
        {row.deal.valueEst != null && (
          <span className="shrink-0 text-sm font-semibold text-success tabular-nums">{fmtCurrency(Number(row.deal.valueEst))}</span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground truncate" title={row.deal.title}>{row.deal.title}</p>
      <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-success">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Won{row.deal.wonAt ? ` · ${format(new Date(row.deal.wonAt), "MMM d, yyyy")}` : ""}
      </p>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={activePipeline?.id ?? ""} onValueChange={setSelectedPipelineId}>
          <SelectTrigger className="w-56 bg-card" aria-label="Pipeline"><SelectValue /></SelectTrigger>
          <SelectContent>
            {pipelineList.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => setAddPipelineOpen(true)}><Plus className="h-4 w-4 mr-1.5" />New Pipeline</Button>
        <div className="flex-1" />
        <Button onClick={() => {
          setDealForm((f) => ({ ...f, pipelineId: activePipeline?.id ?? "" }));
          setAddDealOpen(true);
        }}><Plus className="h-4 w-4 mr-1.5" />New Deal</Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          variant="white" color="green" icon={DollarSign}
          label="Open pipeline value"
          value={fmtCurrency(pipelineAnalytics?.openValueTotal ?? sumValue(openDeals))}
          hint={`${openDeals.length} open deal${openDeals.length === 1 ? "" : "s"}`}
          loading={dealsLoading}
        />
        <KpiCard
          variant="white" color="blue" icon={Gauge}
          label="Weighted forecast"
          value={fmtCurrency(weightedForecast)}
          hint="Open value × stage odds"
          loading={dealsLoading}
        />
        <KpiCard
          variant="white" color="navy" icon={Trophy}
          label="Won deals"
          value={pipelineAnalytics?.wonDeals ?? wonDeals.length}
          hint={`${fmtCurrency(pipelineAnalytics?.wonValueTotal ?? sumValue(wonDeals))} enrolled`}
          loading={dealsLoading}
        />
        <KpiCard
          variant="white" color="orange" icon={Percent}
          label="Conversion rate"
          value={`${pipelineAnalytics?.conversionRate ?? 0}%`}
          hint={`Won out of ${pipelineAnalytics?.totalDeals ?? deals.length} deals`}
          loading={dealsLoading}
        />
      </div>

      {dealsLoading ? <Skeleton className="h-72 w-full rounded-xl" /> : (
        <ScrollArea className="w-full">
          <div className="flex gap-3 pb-4 min-w-max">
            {columns.map((col) => {
              const isFinish = col.key === finishStageId || col.key === "__won";
              const count = col.open.length + col.won.length;
              const value = sumValue(col.open) + sumValue(col.won);
              return (
                <div key={col.key} className="w-64 flex-shrink-0 rounded-xl bg-muted/50 p-2.5">
                  <div className="flex items-center gap-2 px-1">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: col.color }} />
                    <span className="font-display font-semibold text-sm truncate">{col.name}</span>
                    <span className="ml-auto rounded-md bg-card px-1.5 py-0.5 text-xs font-medium text-muted-foreground border border-border">{count}</span>
                  </div>
                  <p className="px-1 mt-1 mb-2.5 text-xs text-muted-foreground tabular-nums">
                    {value > 0 ? fmtCurrency(value) : "No value yet"}
                  </p>
                  <div className="space-y-2 min-h-[96px]">
                    {col.open.map((r) => renderOpenCard(r, col.key === finishStageId))}
                    {col.won.map(renderWonCard)}
                    {count === 0 && (
                      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                        {isFinish ? "Won deals show up here" : "No deals at this stage"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground -mt-2">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Use the <MoreHorizontal className="inline h-3.5 w-3.5" /> menu on a card to move it to another stage or close it.
          {finishStageId
            ? ` Won deals are listed under "${lastStage?.name}".`
            : " Won deals are listed in the Won column."}
          {" "}Lost deals move to the list below.
        </span>
      </p>

      <SectionCard
        title={`Lost deals (${lostDeals.length})`}
        description={lostDeals.length > 0 ? `${fmtCurrency(sumValue(lostDeals))} in estimated value` : undefined}
      >
        {lostDeals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lost deals in this pipeline.</p>
        ) : (
          <ul className="divide-y divide-border">
            {lostDeals.map((r) => (
              <li key={r.deal.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <Link href={`/crm/contacts/${r.deal.contactId}`} className="font-medium text-sm hover:underline">{contactName(r)}</Link>
                <span className="text-sm text-muted-foreground truncate">· {r.deal.title}</span>
                <span className="ml-auto flex items-center gap-2">
                  <StatusPill tone="danger">{r.deal.lostReason || "No reason given"}</StatusPill>
                  {r.deal.lostAt && <span className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(r.deal.lostAt), "MMM d")}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Mark-as-lost dialog (reason is optional) */}
      <Dialog open={lostTarget !== null} onOpenChange={(o) => { if (!o) { setLostTarget(null); setLostReason(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark this deal as lost?</DialogTitle>
            <DialogDescription>
              {lostTarget ? `${contactName(lostTarget)} — ${lostTarget.deal.title}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="lost-reason">Reason (optional)</Label>
            <Textarea
              id="lost-reason"
              placeholder="e.g. Went with another agent, kept current plan…"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setLostTarget(null); setLostReason(""); }}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmLost()}>Mark as lost</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Deal Dialog */}
      <Dialog open={addDealOpen} onOpenChange={onDealOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Deal</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="deal-contact-search">Contact *</Label>
              <Input
                id="deal-contact-search"
                placeholder="Search contacts by name, email, or phone"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
              />
              {dealForm.contactId && <p className="text-sm">Selected: {selectedContactLabel}</p>}
              <div className="max-h-36 overflow-y-auto rounded-md border" role="listbox" aria-label="Contacts">
                {contactsLoading ? <p className="p-2 text-sm text-muted-foreground">Loading contacts…</p>
                  : (contactsData?.data ?? []).length === 0 ? <p className="p-2 text-sm text-muted-foreground">{contactSearch ? "No matching contacts. Try another search." : "No contacts found. Create a contact in CRM first."}</p>
                  : (contactsData?.data ?? []).map((contact) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={dealForm.contactId === contact.id}
                      key={contact.id}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted"
                      onClick={() => {
                        setDealForm((f) => ({ ...f, contactId: contact.id }));
                        setSelectedContactLabel([contact.firstName, contact.lastName].filter(Boolean).join(" "));
                      }}
                    >
                      {contact.firstName} {contact.lastName}{contact.email ? " — " + contact.email : ""}
                    </button>
                  ))}
              </div>
            </div>
            {(contactsData?.total ?? 0) > (contactsData?.data.length ?? 0) && (
              <p className="text-xs text-muted-foreground">Showing {contactsData?.data.length} of {contactsData?.total} contacts. Refine your search to find more.</p>
            )}
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
            <Button variant="outline" onClick={() => onDealOpenChange(false)}>Cancel</Button>
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
