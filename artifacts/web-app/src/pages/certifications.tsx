import { useState } from "react";
import { useGetAhipDashboard, useGetCertificationMatrix, useGetCarriers, useGetAgents, useGetAgentCertifications, useGetAgentAhip, useGetRenewals } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Award, ShieldCheck, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { sellingPlanYear } from "@/lib/planYear";

const CERT_STATUS_STYLES: Record<string, string> = {
  passed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  in_progress: "bg-blue-100 text-blue-800",
  not_started: "bg-slate-100 text-slate-500",
  waived: "bg-purple-100 text-purple-800",
};

const CERT_CELL_STYLES: Record<string, string> = {
  passed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  in_progress: "bg-blue-100 text-blue-700",
  not_started: "bg-slate-50 text-slate-400",
  waived: "bg-purple-100 text-purple-700",
};

export default function CertificationsPage() {
  const currentYear = sellingPlanYear();
  const [year, setYear] = useState(String(currentYear));
  const [view, setView] = useState<"ahip" | "carriers">("ahip");
  const [, navigate] = useLocation();

  const { data: ahip, isLoading: ahipLoading } = useGetAhipDashboard({ year: parseInt(year, 10) });
  const { data: matrix, isLoading: matrixLoading } = useGetCertificationMatrix({ year: parseInt(year, 10) });
  const { data: certRenewals } = useGetRenewals({ days: 90 });
  const expiringCerts = certRenewals?.renewals.filter((r) => r.type === "certification") ?? [];

  const years = [currentYear + 1, currentYear, currentYear - 1].map(String);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Certifications</h1>
          <p className="text-sm text-muted-foreground mt-0.5">AHIP, carrier certifications, and compliance tracking</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={y}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setView("ahip")}
              className={cn("px-3 py-1.5 text-sm", view === "ahip" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              AHIP
            </button>
            <button
              onClick={() => setView("carriers")}
              className={cn("px-3 py-1.5 text-sm", view === "carriers" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              Carriers
            </button>
          </div>
        </div>
      </div>

      {view === "ahip" && (
        <>
          <div className="grid grid-cols-3 gap-4">
            {ahipLoading ? (
              [...Array(3)].map((_, i) => <Skeleton key={i} className="h-24" />)
            ) : (
              <>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-blue-100 flex items-center justify-center">
                        <ShieldCheck className="h-5 w-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold">{ahip?.passedCount ?? 0}</p>
                        <p className="text-xs text-muted-foreground">Agents passed AHIP {year}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-green-100 flex items-center justify-center">
                        <CheckCircle className="h-5 w-5 text-green-600" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold">{Math.round(ahip?.completionRate ?? 0)}%</p>
                        <p className="text-xs text-muted-foreground">Completion rate</p>
                      </div>
                    </div>
                    <Progress value={ahip?.completionRate ?? 0} className="h-1 mt-3" />
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-slate-100 flex items-center justify-center">
                        <AlertTriangle className="h-5 w-5 text-slate-500" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold">{(ahip?.totalActiveAgents ?? 0) - (ahip?.passedCount ?? 0)}</p>
                        <p className="text-xs text-muted-foreground">Not yet completed</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">AHIP Status — {year}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {ahipLoading ? (
                <div className="p-4 space-y-2">
                  {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : (ahip?.records ?? []).length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  <ShieldCheck className="h-8 w-8 mx-auto mb-2 opacity-20" />
                  <p className="text-sm">No AHIP records for {year}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {(ahip?.records ?? []).sort((a, b) => {
                    const order = { passed: 0, in_progress: 1, not_started: 2, failed: 3, waived: 4 };
                    return (order[a.status as keyof typeof order] ?? 5) - (order[b.status as keyof typeof order] ?? 5);
                  }).map((rec) => (
                    <div
                      key={rec.agentId}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => navigate(`/agents/${rec.agentId}`)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{rec.firstName} {rec.lastName}</p>
                        {rec.completedDate && (
                          <p className="text-xs text-muted-foreground">
                            Completed {format(new Date(rec.completedDate), "MMM d, yyyy")}
                          </p>
                        )}
                      </div>
                      {rec.score != null && (
                        <span className="text-sm tabular-nums text-muted-foreground">{rec.score}%</span>
                      )}
                      <Badge variant="secondary" className={cn("text-xs capitalize", CERT_STATUS_STYLES[rec.status] ?? "")}>
                        {rec.status.replace("_", " ")}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {view === "carriers" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Carrier Certification Matrix — {year}</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {matrixLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : (matrix?.agents ?? []).length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">
                <Award className="h-8 w-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm">No active agents or carriers configured</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-2.5 sticky left-0 bg-background z-10 min-w-[160px]">
                      Agent
                    </th>
                    {(matrix?.carriers ?? []).map((carrier) => (
                      <th key={carrier.id} className="text-center text-xs font-semibold text-muted-foreground px-3 py-2.5 min-w-[100px]">
                        {carrier.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(matrix?.agents ?? []).map((agent) => (
                    <tr
                      key={agent.id}
                      className="hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => navigate(`/agents/${agent.id}`)}
                    >
                      <td className="px-4 py-2.5 sticky left-0 bg-background font-medium">
                        {agent.firstName} {agent.lastName}
                      </td>
                      {(matrix?.carriers ?? []).map((carrier) => {
                        const status = matrix?.certMap?.[agent.id]?.[carrier.id] ?? "not_started";
                        return (
                          <td key={carrier.id} className="px-3 py-2.5 text-center">
                            <span className={cn(
                              "inline-block text-[11px] font-medium px-2 py-0.5 rounded-full capitalize",
                              CERT_CELL_STYLES[status] ?? "bg-slate-50 text-slate-400"
                            )}>
                              {status.replace("_", " ")}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {expiringCerts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" />
              Expiring Certifications (Next 90 Days)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {expiringCerts.slice(0, 8).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                  onClick={() => navigate(`/agents/${r.agentId}`)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{r.agentName}</p>
                    <p className="text-xs text-muted-foreground">{r.detail}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{format(new Date(r.expiryDate), "MMM d, yyyy")}</p>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-xs border",
                      r.urgency === "critical" ? "bg-red-100 text-red-800 border-red-200" :
                      r.urgency === "warning" ? "bg-amber-100 text-amber-800 border-amber-200" :
                      "bg-blue-100 text-blue-800 border-blue-200"
                    )}
                  >
                    {r.daysUntilExpiry}d
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
