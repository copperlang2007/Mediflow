import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
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
import { TrendingDown, RotateCcw, Percent, DollarSign, ShieldCheck, Users } from "lucide-react";
import { PageHeader, KpiCard, SectionCard, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame } from "@/components/ops";

interface AgentExposure {
  writingAgentId: string | null;
  agentName: string;
  count: number;
  total: number;
}

interface ClawbackSummary {
  windowDays: number;
  since: string;
  chargebackCount: number;
  clawbackTotal: number;
  grossCommission: number;
  clawbackRate: number;
  byAgent: AgentExposure[];
}

interface ClawbackRow {
  item: {
    id: string;
    policyNumber: string | null;
    planType: string | null;
    commissionAmount: string;
    periodStart: string | null;
    memberId: string | null;
  };
  agentFirstName: string | null;
  agentLastName: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
}

const WINDOWS = [
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
  { value: "730", label: "Last 24 months" },
];

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function moneyStr(s: string): string {
  return money(Math.abs(Number(s)));
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ClawbacksPage() {
  const [days, setDays] = useState("365");
  const windowLabel = (WINDOWS.find((w) => w.value === days)?.label ?? "").toLowerCase();

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["clawbacks", "summary", days],
    queryFn: () => customFetch<ClawbackSummary>(`/api/clawbacks/summary?days=${days}`),
    staleTime: 60_000,
  });

  const { data: rows, isLoading: rowsLoading } = useQuery({
    queryKey: ["clawbacks", "list", days],
    queryFn: () => customFetch<ClawbackRow[]>(`/api/clawbacks?days=${days}`),
  });

  const none = !!summary && summary.chargebackCount === 0;

  return (
    <PageShell>
      <PageHeader
        title="Clawbacks"
        subtitle="Commission a carrier takes back when a member leaves their plan early"
      >
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[170px] h-9 bg-card"><SelectValue /></SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </PageHeader>

      <KpiGrid>
        <KpiCard
          label="Clawed back"
          value={summary ? money(summary.clawbackTotal) : "—"}
          icon={RotateCcw}
          color="navy"
          loading={summaryLoading}
          hint={none ? "Nothing taken back — nice" : `Returned to carriers, ${windowLabel}`}
        />
        <KpiCard
          label="Chargebacks"
          value={summary?.chargebackCount ?? 0}
          icon={TrendingDown}
          color="orange"
          loading={summaryLoading}
          hint={none ? "No early disenrollments" : "Policies that ended early"}
        />
        <KpiCard
          label="Clawback rate"
          value={summary ? `${(summary.clawbackRate * 100).toFixed(1)}%` : "—"}
          icon={Percent}
          color="blue"
          loading={summaryLoading}
          hint="Share of gross commission taken back"
        />
        <KpiCard
          label="Gross commission"
          value={summary ? money(summary.grossCommission) : "—"}
          icon={DollarSign}
          color="green"
          loading={summaryLoading}
          hint={`Paid by carriers, ${windowLabel}`}
        />
      </KpiGrid>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <SectionCard
          className="lg:col-span-2"
          title="Exposure by agent"
          description="Whose policies are being clawed back most"
          icon={Users}
        >
          {summaryLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (summary?.byAgent ?? []).length === 0 ? (
            <EmptyState
              compact
              icon={ShieldCheck}
              title="No clawbacks in this window"
              description="No agent has had commission taken back. Keep it up."
            />
          ) : (
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Chargebacks</TableHead>
                    <TableHead className="text-right">Clawed back</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(summary?.byAgent ?? []).map((a) => (
                    <TableRow key={a.writingAgentId ?? "unassigned"}>
                      <TableCell className="font-medium">{a.agentName}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.count}</TableCell>
                      <TableCell className="text-right text-destructive font-semibold tabular-nums">{money(a.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          )}
        </SectionCard>

        <SectionCard
          className="lg:col-span-3"
          title="Recent chargebacks"
          description="Each policy a carrier charged back, newest first"
          icon={RotateCcw}
        >
          {rowsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (rows ?? []).length === 0 ? (
            <EmptyState
              compact
              icon={ShieldCheck}
              title="No chargebacks in this window — nice"
              description="When a carrier takes commission back on a policy, it will be listed here so you can follow up with the client."
            />
          ) : (
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Policy</TableHead>
                    <TableHead>Member</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(rows ?? []).map((r) => {
                    const member = r.contactFirstName
                      ? `${r.contactFirstName} ${r.contactLastName ?? ""}`.trim()
                      : r.item.memberId ?? "—";
                    const agent = r.agentFirstName
                      ? `${r.agentFirstName} ${r.agentLastName ?? ""}`.trim()
                      : "—";
                    return (
                      <TableRow key={r.item.id}>
                        <TableCell className="font-mono text-xs">{r.item.policyNumber ?? "—"}</TableCell>
                        <TableCell className="font-medium">{member}</TableCell>
                        <TableCell className="text-muted-foreground">{agent}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(r.item.periodStart)}</TableCell>
                        <TableCell className="text-right text-destructive font-semibold tabular-nums">−{moneyStr(r.item.commissionAmount)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableFrame>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
