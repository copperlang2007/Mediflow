import { useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  useGetContacts,
  useGetAgents,
} from "@workspace/api-client-react";
import type { Contact, Agent } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Search,
  Inbox,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame } from "@/components/ops";
import { DollarSign, ListChecks, Link2, CalendarCheck, FileSearch, CheckCircle2 } from "lucide-react";

type StatementStatus = "pending" | "parsed" | "reconciled" | "disputed";
/** What to SHOW — from the API's shared derivation (lib/commissions/statementStatus.ts). */
type StatementDisplayStatus = StatementStatus | "reconciled_with_variance";

type CommissionStatement = {
  id: string;
  carrierId: string;
  carrierName?: string | null;
  periodStart: string;
  periodEnd: string;
  totalAmount: number | string;
  status: StatementStatus;
  lineItemCount?: number | null;
  matchedCount?: number | null;
  unmatchedCount?: number | null;
  reconciledAt?: string | null;
  lineItemTotal?: number | null;
  /** Carrier total minus the parsed lines; null when there's nothing to compare. */
  variance?: number | null;
  displayStatus?: StatementDisplayStatus;
};

type LineItemMatchStatus = "matched" | "unmatched" | "manual";

type CommissionLineItem = {
  id: string;
  contactId?: string | null;
  contactName?: string | null;
  memberId?: string | null;
  policyNumber?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  premiumAmount?: number | string | null;
  commissionAmount: number | string;
  type?: string | null;
  writingAgentId?: string | null;
  writingAgentName?: string | null;
  matchStatus: LineItemMatchStatus;
};

type LineItemsResponse =
  | CommissionLineItem[]
  | { data: CommissionLineItem[] };

function unwrap<T>(resp: T[] | { data: T[] } | undefined | null): T[] {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  return resp.data ?? [];
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmtMoney = (val: number | string | null | undefined): string => {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (Number.isNaN(n)) return "—";
  return usd.format(n);
};
const fmtDate = (d: string | null | undefined): string =>
  d ? format(new Date(d), "MMM d, yyyy") : "—";

const STATUS_TONES: Record<StatementDisplayStatus, StatusTone> = {
  pending: "warning",
  parsed: "info",
  reconciled: "success",
  reconciled_with_variance: "warning",
  disputed: "danger",
};

const MATCH_TONES: Record<LineItemMatchStatus, StatusTone> = {
  matched: "success",
  unmatched: "danger",
  manual: "navy",
};

const MATCH_LABELS: Record<LineItemMatchStatus, string> = {
  matched: "Matched",
  unmatched: "Needs a match",
  manual: "Matched by hand",
};

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Match dialog (paginated combobox-style pickers backed by useGetContacts /
// useGetAgents — lightweight approach with debounced search instead of a full
// virtualised combobox, since these endpoints already support search server-
// side and that behaves well for long lists.)
// ---------------------------------------------------------------------------

function MatchDialog({
  lineItem,
  onClose,
  onMatched,
}: {
  lineItem: CommissionLineItem | null;
  onClose: () => void;
  onMatched: () => void;
}) {
  const [contactSearch, setContactSearch] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [contactId, setContactId] = useState<string>(lineItem?.contactId ?? "");
  const [agentId, setAgentId] = useState<string>(lineItem?.writingAgentId ?? "");

  const { data: contactsData, isLoading: contactsLoading } = useGetContacts({
    search: contactSearch || undefined,
    limit: 25,
  });
  const contacts: Contact[] = (contactsData?.data ?? []) as Contact[];

  const { data: agents, isLoading: agentsLoading } = useGetAgents({ status: "active" });
  const filteredAgents = useMemo<Agent[]>(() => {
    // The agents endpoint returns `{ agents: [...] }`; tolerate a bare array too.
    const raw = agents as unknown;
    const list: Agent[] = Array.isArray(raw)
      ? (raw as Agent[])
      : ((raw as { agents?: Agent[] } | undefined)?.agents ?? []);
    if (!agentSearch) return list.slice(0, 25);
    const q = agentSearch.toLowerCase();
    return list
      .filter((a) =>
        `${a.firstName} ${a.lastName} ${a.email}`.toLowerCase().includes(q),
      )
      .slice(0, 25);
  }, [agents, agentSearch]);

  const save = useMutation({
    mutationFn: () => {
      if (!lineItem) throw new Error("No line item");
      return customFetch(`/api/commissions/line-items/${lineItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contactId || null,
          writingAgentId: agentId || null,
          match_status: "manual",
        }),
      });
    },
    onSuccess: () => {
      toast.success("Match saved");
      onMatched();
      onClose();
    },
    onError: () => toast.error("Failed to save match"),
  });

  return (
    <Dialog open={!!lineItem} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Match line item</DialogTitle>
        </DialogHeader>
        {lineItem && (
          <div className="space-y-4">
            <div className="rounded-md bg-muted/50 p-3 text-xs space-y-0.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Member ID</span>
                <span className="font-mono">{lineItem.memberId ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Policy #</span>
                <span className="font-mono">{lineItem.policyNumber ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Commission</span>
                <span className="font-medium">{fmtMoney(lineItem.commissionAmount)}</span>
              </div>
            </div>

            {/* Contact picker */}
            <div className="space-y-1.5">
              <Label>Contact</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  className="pl-9 h-9"
                  placeholder="Search contacts…"
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                />
              </div>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                {contactsLoading ? (
                  <div className="p-3 text-xs text-muted-foreground">Loading…</div>
                ) : contacts.length === 0 ? (
                  <div className="p-3 text-xs text-muted-foreground">No contacts</div>
                ) : (
                  contacts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setContactId(c.id)}
                      className={cn(
                        "w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors",
                        contactId === c.id && "bg-primary/10 text-primary font-medium",
                      )}
                    >
                      {c.firstName} {c.lastName}
                      {c.medicareId && (
                        <span className="ml-2 text-muted-foreground font-mono">{c.medicareId}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Agent picker */}
            <div className="space-y-1.5">
              <Label>Writing agent</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  className="pl-9 h-9"
                  placeholder="Search agents…"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                />
              </div>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                {agentsLoading ? (
                  <div className="p-3 text-xs text-muted-foreground">Loading…</div>
                ) : filteredAgents.length === 0 ? (
                  <div className="p-3 text-xs text-muted-foreground">No agents</div>
                ) : (
                  filteredAgents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAgentId(a.id)}
                      className={cn(
                        "w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors",
                        agentId === a.id && "bg-primary/10 text-primary font-medium",
                      )}
                    >
                      {a.firstName} {a.lastName}
                      <span className="ml-2 text-muted-foreground">{a.email}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || (!contactId && !agentId)} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save match"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CommissionStatementPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const [filter, setFilter] = useState<"all" | LineItemMatchStatus>("all");
  const [page, setPage] = useState(1);
  const [matchFor, setMatchFor] = useState<CommissionLineItem | null>(null);

  const { data: statement, isLoading } = useQuery<CommissionStatement>({
    queryKey: ["/api/commissions/statements", id],
    queryFn: () => customFetch<CommissionStatement>(`/api/commissions/statements/${id}`),
    enabled: !!id,
  });

  const lineItemsQs = filter === "all" ? "" : `?match_status=${filter}`;

  const { data: itemsData, isLoading: itemsLoading } = useQuery<LineItemsResponse>({
    queryKey: ["/api/commissions/statements", id, "line-items", { matchStatus: filter }],
    queryFn: () =>
      customFetch<LineItemsResponse>(
        `/api/commissions/statements/${id}/line-items${lineItemsQs}`,
      ),
    enabled: !!id,
  });
  const rows = unwrap(itemsData);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const reconcile = useMutation({
    mutationFn: () =>
      customFetch(`/api/commissions/statements/${id}/reconcile`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Reconcile started");
      void qc.invalidateQueries({ queryKey: ["/api/commissions/statements", id] });
      void qc.invalidateQueries({
        queryKey: ["/api/commissions/statements", id, "line-items"],
      });
    },
    onError: () => toast.error("Reconcile failed"),
  });

  if (isLoading) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </PageShell>
    );
  }

  if (!statement) {
    return (
      <PageShell>
        <SectionCard>
          <EmptyState
            icon={FileSearch}
            title="We couldn't find that statement"
            description="It may have been removed, or it belongs to a different agency."
            action={{ label: "Back to Commissions", onClick: () => navigate("/commissions") }}
          />
        </SectionCard>
      </PageShell>
    );
  }

  const hasVariance = statement.variance != null && Math.abs(statement.variance) >= 0.01;
  // Never show a green "Reconciled" when the lines don't add up to the total.
  const shownStatus: StatementDisplayStatus =
    statement.displayStatus ??
    (statement.status === "reconciled" && hasVariance ? "reconciled_with_variance" : statement.status);

  const FILTER_OPTIONS: Array<{ value: "all" | LineItemMatchStatus; label: string }> = [
    { value: "all", label: "All" },
    { value: "matched", label: "Matched" },
    { value: "unmatched", label: "Unmatched" },
    { value: "manual", label: "Manual" },
  ];

  return (
    <PageShell>
      <Button variant="ghost" size="sm" className="-ml-1 -mb-2 text-muted-foreground" onClick={() => navigate("/commissions")}>
        <ArrowLeft className="h-4 w-4 mr-1.5" />
        Commissions
      </Button>

      <PageHeader
        eyebrow="Commission statement"
        title={statement.carrierName ?? "Statement"}
        subtitle={`Covers ${fmtDate(statement.periodStart)} – ${fmtDate(statement.periodEnd)}`}
      >
        <StatusPill
          status={shownStatus}
          tone={STATUS_TONES[shownStatus]}
          className="text-sm px-3 py-1"
        />
        {statement.status === "parsed" && (
          <Button onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
            {reconcile.isPending ? "Reconciling…" : "Reconcile"}
          </Button>
        )}
      </PageHeader>

      <KpiGrid>
        <KpiCard label="Statement total" value={fmtMoney(statement.totalAmount)} icon={DollarSign} color="navy" hint="What the carrier says it paid" />
        <KpiCard label="Line items" value={statement.lineItemCount ?? rows.length} icon={ListChecks} color="blue" hint="One per policy on the statement" />
        <KpiCard
          label="Matched / needs a match"
          value={
            <>
              {statement.matchedCount ?? rows.filter((r) => r.matchStatus !== "unmatched").length}
              <span className="text-white/60"> / </span>
              {statement.unmatchedCount ?? rows.filter((r) => r.matchStatus === "unmatched").length}
            </>
          }
          icon={Link2}
          color="green"
          hint={(statement.unmatchedCount ?? 0) === 0 ? "Every line is linked to a client" : "Match the rest by hand below"}
        />
        <KpiCard
          label="Last reconciled"
          value={
            <span className="text-2xl">
              {statement.reconciledAt
                ? fmtDate(statement.reconciledAt)
                : statement.status === "reconciled"
                  ? "Not recorded"
                  : "—"}
            </span>
          }
          icon={CalendarCheck}
          color="orange"
          hint={
            statement.status !== "reconciled"
              ? "Not reconciled yet"
              : hasVariance
                ? `Lines are ${fmtMoney(Math.abs(statement.variance ?? 0))} ${(statement.variance ?? 0) > 0 ? "short of" : "over"} the carrier total — needs review`
                : statement.reconciledAt
                  ? "Payouts are up to date"
                  : "Reconciled before times were recorded"
          }
        />
      </KpiGrid>

      <SectionCard title="Line items" description="Each policy the carrier paid on, and who it's linked to">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => { setFilter(opt.value); setPage(1); }}
            className={cn(
              "text-xs px-3 py-1.5 rounded-full border transition-colors",
              filter === opt.value
                ? "bg-navy-800 text-white border-navy-800 dark:bg-primary dark:text-primary-foreground dark:border-primary"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {itemsLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        filter === "unmatched" ? (
          <EmptyState
            icon={CheckCircle2}
            title="Nothing left to match — nice"
            description="Every line on this statement is linked to a client and agent."
          />
        ) : (
          <EmptyState
            icon={Inbox}
            title={filter === "all" ? "No line items yet" : "No line items with this match status"}
            description={
              filter === "all"
                ? "Once the statement file has been read, each policy it pays on will appear here."
                : "Try another filter, or show all line items."
            }
          />
        )
      ) : (
        <>
          <TableFrame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Policy #</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Premium</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Writing agent</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.map((li) => (
                  <TableRow key={li.id}>
                    <TableCell className="font-medium">
                      {li.contactName ?? (
                        li.matchStatus === "unmatched" ? (
                          <span className="text-muted-foreground italic">
                            Unmatched{li.memberId && ` · ${li.memberId}`}
                          </span>
                        ) : (
                          <span>{li.memberId ? `Member ${li.memberId}` : "Linked client"}</span>
                        )
                      )}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {li.policyNumber ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {fmtDate(li.periodStart)} – {fmtDate(li.periodEnd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(li.premiumAmount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-success">
                      {fmtMoney(li.commissionAmount)}
                    </TableCell>
                    <TableCell>
                      {li.type ? (
                        <StatusPill tone={li.type === "chargeback" ? "danger" : "neutral"}>{li.type}</StatusPill>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {li.writingAgentName ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={MATCH_TONES[li.matchStatus]}>{MATCH_LABELS[li.matchStatus]}</StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {li.matchStatus === "unmatched" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setMatchFor(li)}>
                          Match
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
          <div className="flex items-center justify-between text-xs text-muted-foreground pt-3">
            <span>{rows.length} line item{rows.length !== 1 ? "s" : ""}</span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage <= 1}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="tabular-nums">Page {safePage} of {totalPages}</span>
              <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setPage(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}
      </SectionCard>

      <MatchDialog
        lineItem={matchFor}
        onClose={() => setMatchFor(null)}
        onMatched={() => {
          void qc.invalidateQueries({
            queryKey: ["/api/commissions/statements", id, "line-items"],
          });
          void qc.invalidateQueries({ queryKey: ["/api/commissions/statements", id] });
        }}
      />
    </PageShell>
  );
}
