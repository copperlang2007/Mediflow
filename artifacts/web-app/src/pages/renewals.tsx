import { useState } from "react";
import {
  useGetRenewals,
  useSnoozeRenewal,
  useResolveRenewal,
  getGetRenewalsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCcw, AlertTriangle, Clock, Info, CheckCircle2, BellOff } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

const URGENCY_CONFIG = {
  critical: { label: "Critical", color: "bg-red-100 text-red-800 border-red-200", icon: AlertTriangle, iconColor: "text-red-500" },
  warning: { label: "Warning", color: "bg-amber-100 text-amber-800 border-amber-200", icon: Clock, iconColor: "text-amber-500" },
  notice: { label: "Notice", color: "bg-blue-100 text-blue-800 border-blue-200", icon: Info, iconColor: "text-blue-500" },
};

type UrgencyFilter = "all" | "critical" | "warning" | "notice";
type TypeFilter = "all" | "license" | "certification";

export default function RenewalsPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [days, setDays] = useState(90);
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const { data, isLoading, refetch } = useGetRenewals({ days });
  const { mutateAsync: snooze, isPending: snoozing } = useSnoozeRenewal();
  const { mutateAsync: resolve, isPending: resolving } = useResolveRenewal();

  const renewals = (data?.renewals ?? []).filter((r) => {
    if (urgencyFilter !== "all" && r.urgency !== urgencyFilter) return false;
    if (typeFilter !== "all" && r.type !== typeFilter) return false;
    return true;
  });

  const counts = {
    critical: (data?.renewals ?? []).filter((r) => r.urgency === "critical").length,
    warning: (data?.renewals ?? []).filter((r) => r.urgency === "warning").length,
    notice: (data?.renewals ?? []).filter((r) => r.urgency === "notice").length,
  };

  const handleSnooze = async (resourceType: string, id: string, agentName: string) => {
    try {
      await snooze({ resourceType: resourceType as "license" | "certification", id, data: { days: 30 } });
      toast.success(`Snoozed ${agentName}'s renewal for 30 days`);
      void qc.invalidateQueries({ queryKey: getGetRenewalsQueryKey() });
    } catch {
      toast.error("Failed to snooze renewal");
    }
  };

  const handleResolve = async (resourceType: string, id: string, agentName: string) => {
    try {
      await resolve({ resourceType: resourceType as "license" | "certification", id });
      toast.success(`Marked ${agentName}'s renewal as resolved`);
      void qc.invalidateQueries({ queryKey: getGetRenewalsQueryKey() });
    } catch {
      toast.error("Failed to resolve renewal");
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Renewals</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Track upcoming license and certification expirations</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Urgency summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {(["critical", "warning", "notice"] as const).map((urgency) => {
          const cfg = URGENCY_CONFIG[urgency];
          const IconComp = cfg.icon;
          return (
            <button
              key={urgency}
              onClick={() => setUrgencyFilter(urgencyFilter === urgency ? "all" : urgency)}
              className={`rounded-lg border p-4 text-left transition-all hover:shadow-sm
                ${urgencyFilter === urgency ? "ring-2 ring-primary ring-offset-1" : ""}
                ${urgency === "critical" ? "border-red-200 bg-red-50" : urgency === "warning" ? "border-amber-200 bg-amber-50" : "border-blue-200 bg-blue-50"}`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold uppercase tracking-wide ${cfg.iconColor}`}>
                  {cfg.label}
                </span>
                <IconComp className={`h-4 w-4 ${cfg.iconColor}`} />
              </div>
              <div className={`text-2xl font-bold mt-1 ${cfg.iconColor}`}>{counts[urgency]}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {urgency === "critical" ? "Expiring in ≤30 days" : urgency === "warning" ? "31–60 days" : "61–90 days"}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="license">Licenses</SelectItem>
            <SelectItem value="certification">Certifications</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">Next 30 days</SelectItem>
            <SelectItem value="60">Next 60 days</SelectItem>
            <SelectItem value="90">Next 90 days</SelectItem>
            <SelectItem value="180">Next 180 days</SelectItem>
          </SelectContent>
        </Select>
        {urgencyFilter !== "all" && (
          <Button variant="ghost" size="sm" onClick={() => setUrgencyFilter("all")}>
            Clear filter
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3 pt-4 px-5">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {renewals.length} renewal{renewals.length !== 1 ? "s" : ""}
            {urgencyFilter !== "all" ? ` (${urgencyFilter})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : renewals.length === 0 ? (
            <div className="py-16 text-center">
              <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-green-400/60" />
              <p className="text-sm font-medium text-muted-foreground">No renewals due</p>
              <p className="text-xs text-muted-foreground mt-1">
                {urgencyFilter !== "all" || typeFilter !== "all"
                  ? "Try adjusting your filters"
                  : `No expiring items in the next ${days} days`}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-5 py-2.5 border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Item</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-20 text-center">Type</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24 text-center">Expires</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-20 text-center">Urgency</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-36 text-right">Actions</span>
              </div>
              <div className="divide-y divide-border">
                {renewals.map((item) => {
                  const cfg = URGENCY_CONFIG[item.urgency as keyof typeof URGENCY_CONFIG];
                  const IconComp = cfg?.icon ?? Info;
                  return (
                    <div
                      key={`${item.type}-${item.id}`}
                      className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors"
                    >
                      <div className="min-w-0">
                        <button
                          className="font-medium text-sm text-foreground hover:underline text-left"
                          onClick={() => navigate(`/agents/${item.agentId}`)}
                        >
                          {item.agentName}
                        </button>
                        <p className="text-xs text-muted-foreground truncate">{item.detail}</p>
                      </div>
                      <div className="w-20 flex justify-center">
                        <Badge variant="secondary" className="text-xs capitalize">
                          {item.type === "license" ? "License" : "Cert"}
                        </Badge>
                      </div>
                      <div className="w-24 text-center">
                        <div className="text-sm font-semibold tabular-nums">
                          {item.daysUntilExpiry}d
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.expiryDate ? new Date(item.expiryDate).toLocaleDateString() : "—"}
                        </div>
                      </div>
                      <div className="w-20 flex justify-center">
                        <Badge
                          variant="secondary"
                          className={`text-xs border capitalize flex items-center gap-1 ${cfg?.color ?? ""}`}
                        >
                          <IconComp className="h-3 w-3" />
                          {cfg?.label ?? item.urgency}
                        </Badge>
                      </div>
                      <div className="w-36 flex items-center justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={snoozing || resolving}
                          onClick={() => handleSnooze(item.type ?? "license", item.id, item.agentName ?? "")}
                          title="Snooze for 30 days"
                        >
                          <BellOff className="h-3.5 w-3.5 mr-1" />
                          Snooze
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs text-green-700 border-green-200 hover:bg-green-50"
                          disabled={snoozing || resolving}
                          onClick={() => handleResolve(item.type ?? "license", item.id, item.agentName ?? "")}
                          title="Mark as resolved"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Resolve
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {data && data.total > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {renewals.length} of {data.total} upcoming renewals (snoozed items hidden)
        </p>
      )}
    </div>
  );
}
