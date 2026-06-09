import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { TrendingDown, RotateCcw, Percent, Users } from "lucide-react";

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

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["clawbacks", "summary", days],
    queryFn: () => customFetch<ClawbackSummary>(`/api/clawbacks/summary?days=${days}`),
    staleTime: 60_000,
  });

  const { data: rows, isLoading: rowsLoading } = useQuery({
    queryKey: ["clawbacks", "list", days],
    queryFn: () => customFetch<ClawbackRow[]>(`/api/clawbacks?days=${days}`),
  });

  const cards = [
    { label: "Clawed back", value: summary ? money(summary.clawbackTotal) : "—", icon: RotateCcw, className: "text-red-600" },
    { label: "Chargebacks", value: summary?.chargebackCount ?? 0, icon: TrendingDown, className: "text-amber-600" },
    { label: "Clawback rate", value: summary ? `${(summary.clawbackRate * 100).toFixed(1)}%` : "—", icon: Percent, className: "text-violet-600" },
    { label: "Gross commission", value: summary ? money(summary.grossCommission) : "—", icon: Users, className: "text-slate-600" },
  ];

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Clawback Exposure</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Commission charged back by carriers when members disenroll early
          </p>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[170px] h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</span>
                <Icon className={`h-4 w-4 ${card.className}`} />
              </div>
              <div className={`text-2xl font-bold mt-1 ${card.className}`}>
                {summaryLoading ? <Skeleton className="h-7 w-20" /> : card.value}
              </div>
            </div>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Exposure by writing agent</CardTitle>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (summary?.byAgent ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No clawbacks in this window.</p>
          ) : (
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
                    <TableCell className="text-right">{a.count}</TableCell>
                    <TableCell className="text-right text-red-600 font-medium">{money(a.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Recent chargebacks</CardTitle>
        </CardHeader>
        <CardContent>
          {rowsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (rows ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No chargebacks in this window.</p>
          ) : (
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
                      <TableCell className="font-medium">{r.item.policyNumber ?? "—"}</TableCell>
                      <TableCell>{member}</TableCell>
                      <TableCell>{agent}</TableCell>
                      <TableCell>{fmtDate(r.item.periodStart)}</TableCell>
                      <TableCell className="text-right text-red-600 font-medium">{moneyStr(r.item.commissionAmount)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
