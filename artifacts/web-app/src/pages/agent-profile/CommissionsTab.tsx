import { useGetMe, customFetch } from "@workspace/api-client-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DollarSign } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type AgentCommissionsResponse = {
  lifetimeEarned?: number | string;
  ytdEarned?: number | string;
  currentPeriodEarned?: number | string;
  pendingPayouts?: number | string;
  periods?: Array<{
    id?: string;
    period: string;
    earned: number | string;
    paid: number | string;
    status: string;
  }>;
  recentLineItems?: Array<{
    id: string;
    statementId?: string | null;
    carrierName?: string | null;
    contactName?: string | null;
    policyNumber?: string | null;
    commissionAmount: number | string;
    type?: string | null;
    statementDate?: string | null;
  }>;
};

const COMMISSIONS_USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmtUsd = (val: number | string | null | undefined): string => {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (Number.isNaN(n)) return "—";
  return COMMISSIONS_USD.format(n);
};

export default function CommissionsTab({ agentId }: { agentId: string }) {
  const { data: me } = useGetMe();
  const isAdmin =
    me?.role === "super_admin" ||
    me?.role === "agency_admin" ||
    me?.role === "compliance_manager";

  const { data, isLoading, refetch } = useQuery<AgentCommissionsResponse>({
    queryKey: ["/api/agents", agentId, "commissions"],
    queryFn: () =>
      customFetch<AgentCommissionsResponse>(`/api/agents/${agentId}/commissions`),
    enabled: !!agentId,
  });

  const markPaid = useMutation({
    mutationFn: (periodId: string) =>
      customFetch(`/api/agents/${agentId}/commissions/${periodId}/mark-paid`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Marked as paid");
      void refetch();
    },
    onError: () => toast.error("Failed to mark paid"),
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  const periods = data?.periods ?? [];
  const recent = data?.recentLineItems ?? [];

  const cards = [
    { label: "Lifetime earned", value: fmtUsd(data?.lifetimeEarned) },
    { label: "YTD earned", value: fmtUsd(data?.ytdEarned) },
    { label: "Current period", value: fmtUsd(data?.currentPeriodEarned) },
    { label: "Pending payouts", value: fmtUsd(data?.pendingPayouts) },
  ];

  return (
    <div className="p-6 space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-border p-3 space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
              {c.label}
            </p>
            <p className="text-lg font-bold tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold">Per-period payouts</p>
        {periods.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground rounded-lg border border-dashed border-border">
            <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-20" />
            <p className="text-xs">No payout periods yet</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Period</th>
                  <th className="text-right px-3 py-2 font-medium">Earned</th>
                  <th className="text-right px-3 py-2 font-medium">Paid</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  {isAdmin && <th className="text-right px-3 py-2 font-medium">Action</th>}
                </tr>
              </thead>
              <tbody>
                {periods.map((p, i) => (
                  <tr key={p.id ?? `${p.period}-${i}`} className="border-t border-border">
                    <td className="px-3 py-2">{p.period}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(p.earned)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(p.paid)}</td>
                    <td className="px-3 py-2 capitalize">
                      <Badge variant="secondary" className="text-[10px]">{p.status}</Badge>
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-2 text-right">
                        {p.status !== "paid" && p.id && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-xs"
                            disabled={markPaid.isPending}
                            onClick={() => p.id && markPaid.mutate(p.id)}
                          >
                            Mark paid
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold">Recent line items</p>
        {recent.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground rounded-lg border border-dashed border-border">
            <p className="text-xs">No recent line items</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {recent.slice(0, 20).map((li) => (
              <div key={li.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {li.contactName ?? "Unmatched"}
                    {li.carrierName && (
                      <span className="text-muted-foreground font-normal"> · {li.carrierName}</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {li.policyNumber && <span className="font-mono mr-2">{li.policyNumber}</span>}
                    {li.statementDate && format(new Date(li.statementDate), "MMM d, yyyy")}
                  </p>
                </div>
                {li.type && <Badge variant="secondary" className="text-[10px] uppercase">{li.type}</Badge>}
                <span className="tabular-nums font-medium">{fmtUsd(li.commissionAmount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
