/**
 * Policies — the agency's book of business (agencyBRIDGE "Policies &
 * Commissions", policies half), backed by the real `enrollments` table.
 *
 * Every number and row comes from `GET /api/enrollments` and
 * `GET /api/enrollments/summary` with the same filters, so "Showing X of Y"
 * is exact. Premium and per-policy commission are not tracked on enrollments
 * yet, so they are not shown (commission money lives on Commissions).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO, differenceInCalendarDays } from "date-fns";
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Hourglass,
  Scale,
  Search,
  X,
} from "lucide-react";
import {
  customFetch,
  useGetAgents,
  useGetCarriers,
  useGetMe,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, KpiCard, PageHeader, SectionCard, StatusPill } from "@/components/shared";
import { downloadExport } from "@/lib/exports";

export type PolicyRow = {
  id: string;
  contactId: string;
  carrierId: string | null;
  carrierName: string | null;
  agentId: string | null;
  planId: string | null;
  planName: string | null;
  planType: string;
  planYear: number;
  policyNumber: string | null;
  effectiveDate: string;
  effectuated: boolean;
  status: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  agentFirstName: string | null;
  agentLastName: string | null;
};

type Summary = {
  total: number;
  active: number;
  pending: number;
  ended: number;
  effectuated: number;
  notEffectuated: number;
  startingSoon: number;
};

const PAGE_SIZE = 25;
const ALL = "all";

const PLAN_TYPE_LABELS: Record<string, string> = {
  MA: "Medicare Advantage",
  MAPD: "Medicare Advantage + Drug",
  PDP: "Part D (drug plan)",
  supp: "Medicare Supplement",
  other: "Other",
};

const STATUS_OPTIONS = ["active", "pending", "terminated", "cancelled", "declined"];

/** Who may download the whole-book CSV (server: contact:update + step-up). */
const EXPORT_ROLES = ["super_admin", "agency_admin", "compliance_manager", "agent_support"];
const ADMIN_ROLES = ["super_admin", "agency_admin"];

function fullName(first: string | null, last: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

export function buildPolicyQuery(filters: Record<string, string>, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v && v !== ALL) p.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export default function PoliciesPage() {
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const role = me?.role ?? "";

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(ALL);
  const [planType, setPlanType] = useState(ALL);
  const [carrierId, setCarrierId] = useState(ALL);
  const [agentId, setAgentId] = useState(ALL);
  const [effectuated, setEffectuated] = useState(ALL);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  // Debounce the free-text search so every keystroke isn't a request.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters = useMemo(
    () => ({ search, status, planType, carrierId, agentId, effectuated, effectiveFrom, effectiveTo }),
    [search, status, planType, carrierId, agentId, effectuated, effectiveFrom, effectiveTo],
  );
  useEffect(() => setPage(0), [filters]);

  const listQuery = useQuery({
    queryKey: ["/api/enrollments", filters, page],
    queryFn: () =>
      customFetch<PolicyRow[]>(
        `/api/enrollments${buildPolicyQuery(filters, { limit: PAGE_SIZE, offset: page * PAGE_SIZE })}`,
      ),
  });
  const summaryQuery = useQuery({
    queryKey: ["/api/enrollments/summary", filters],
    queryFn: () => customFetch<Summary>(`/api/enrollments/summary${buildPolicyQuery(filters)}`),
  });
  // Unfiltered totals for the headline cards.
  const bookQuery = useQuery({
    queryKey: ["/api/enrollments/summary", "book"],
    queryFn: () => customFetch<Summary>("/api/enrollments/summary"),
  });

  const { data: carriers } = useGetCarriers();
  const { data: agentsData } = useGetAgents({ limit: 200, sortBy: "name" });
  const agents = agentsData?.agents ?? [];

  const rows = listQuery.data ?? [];
  const filteredTotal = summaryQuery.data?.total ?? 0;
  const book = bookQuery.data;
  const anyFilter = Boolean(
    search || status !== ALL || planType !== ALL || carrierId !== ALL || agentId !== ALL ||
      effectuated !== ALL || effectiveFrom || effectiveTo,
  );

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setStatus(ALL);
    setPlanType(ALL);
    setCarrierId(ALL);
    setAgentId(ALL);
    setEffectuated(ALL);
    setEffectiveFrom("");
    setEffectiveTo("");
  };

  const handleExport = async () => {
    setExporting(true);
    const result = await downloadExport(
      "/api/reports/policies/export",
      `policies-${new Date().toISOString().slice(0, 10)}.csv`,
    );
    setExporting(false);
    if (result.ok) toast({ title: "Export ready", description: "Your policies file has downloaded." });
    else toast({ title: "Couldn't export", description: result.message, variant: "destructive" });
  };

  const today = new Date();
  const firstShown = filteredTotal === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = page * PAGE_SIZE + rows.length;
  const hasNext = lastShown < filteredTotal;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Policies"
        subtitle="Every plan your clients are enrolled in — carrier, plan type, status and start date"
      >
        {EXPORT_ROLES.includes(role) && (
          <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={exporting}>
            <Download className="mr-1.5 h-4 w-4" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        )}
        {ADMIN_ROLES.includes(role) && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/reconciliation">
              <Scale className="mr-1.5 h-4 w-4" />
              Reconciliation
            </Link>
          </Button>
        )}
        <Button size="sm" asChild>
          <Link href="/crm">Add from a client</Link>
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Active policies" value={book?.active ?? 0} icon={FileText} color="navy" loading={bookQuery.isLoading}
          hint={book ? `${book.total} on the books in total` : undefined} />
        <KpiCard label="Waiting on the carrier" value={book?.pending ?? 0} icon={Hourglass} color="blue" loading={bookQuery.isLoading}
          hint="Submitted, not yet active" />
        <KpiCard label="Effectuated" value={book?.effectuated ?? 0} icon={CheckCircle2} color="green" loading={bookQuery.isLoading}
          hint={book ? `${book.notEffectuated} still to confirm` : undefined} />
        <KpiCard label="Starting in 60 days" value={book?.startingSoon ?? 0} icon={CalendarClock} color="orange" loading={bookQuery.isLoading}
          hint="Effective date coming up" />
      </div>

      <SectionCard contentClassName="space-y-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative flex-1 xl:max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search client or policy #…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9"
                aria-label="Search policies"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect label="Status" value={status} onChange={setStatus} width="w-[140px]"
                options={[{ value: ALL, label: "All statuses" }, ...STATUS_OPTIONS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))]} />
              <FilterSelect label="Plan type" value={planType} onChange={setPlanType} width="w-[170px]"
                options={[{ value: ALL, label: "All plan types" }, ...Object.entries(PLAN_TYPE_LABELS).map(([value, label]) => ({ value, label }))]} />
              <FilterSelect label="Carrier" value={carrierId} onChange={setCarrierId} width="w-[160px]"
                options={[{ value: ALL, label: "All carriers" }, ...(carriers ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
              <FilterSelect label="Agent" value={agentId} onChange={setAgentId} width="w-[160px]"
                options={[{ value: ALL, label: "All agents" }, ...agents.map((a) => ({ value: a.id, label: `${a.firstName} ${a.lastName}` }))]} />
              <FilterSelect label="Effectuated" value={effectuated} onChange={setEffectuated} width="w-[170px]"
                options={[
                  { value: ALL, label: "Effectuated or not" },
                  { value: "true", label: "Effectuated" },
                  { value: "false", label: "Not yet effectuated" },
                ]} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Effective between</span>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="h-9 w-[160px]" aria-label="Effective from" />
            <span className="text-muted-foreground">and</span>
            <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className="h-9 w-[160px]" aria-label="Effective to" />
            {anyFilter && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-3.5 w-3.5" />
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {listQuery.isLoading ? (
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : listQuery.isError ? (
          <EmptyState icon={FileText} title="Couldn't load policies" description="Please refresh the page. If it keeps happening, contact your administrator." />
        ) : rows.length === 0 ? (
          anyFilter ? (
            <EmptyState icon={Search} title="No policies match these filters" description="Try widening the dates or clearing a filter." action={{ label: "Clear filters", onClick: clearFilters }} />
          ) : (
            <EmptyState
              icon={FileText}
              title="No policies yet"
              description="Policies appear here when you record a plan on a client's page, or import them from a spreadsheet."
              action={{ label: "Go to Clients & Leads", href: "/crm" }}
            />
          )
        ) : (
          <>
            <div className="rounded-lg border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead>Policy #</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Plan type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Effectuated</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead>Agent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => {
                    const days = differenceInCalendarDays(parseISO(p.effectiveDate), today);
                    const soon = days >= 0 && days <= 60;
                    const client = fullName(p.contactFirstName, p.contactLastName) || "Client";
                    const agent = fullName(p.agentFirstName, p.agentLastName);
                    return (
                      <TableRow key={p.id} className="hover:bg-muted/30">
                        <TableCell className="font-mono text-xs">{p.policyNumber ?? <span className="text-muted-foreground">Not issued yet</span>}</TableCell>
                        <TableCell className="font-medium text-sm">
                          <Link href={`/crm/contacts/${p.contactId}`} className="hover:text-accent hover:underline underline-offset-2">
                            {client}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.carrierName ?? "—"}</TableCell>
                        <TableCell className="text-sm">
                          <span className="font-medium">{p.planType === "supp" ? "Supplement" : p.planType}</span>
                          {p.planName && <span className="block text-xs text-muted-foreground truncate max-w-[200px]">{p.planName}</span>}
                        </TableCell>
                        <TableCell><StatusPill status={p.status} /></TableCell>
                        <TableCell>
                          {p.effectuated ? (
                            <StatusPill tone="success">Confirmed</StatusPill>
                          ) : (
                            <StatusPill tone="neutral">Not yet</StatusPill>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className={soon ? "text-sm font-medium text-warning" : "text-sm text-muted-foreground"}>
                            {formatDate(p.effectiveDate)}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{agent || "Unassigned"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <p className="text-sm text-muted-foreground">
                Showing {firstShown}–{lastShown} of {filteredTotal} {filteredTotal === 1 ? "policy" : "policies"}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  width,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  width: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={`h-9 ${width}`} aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
