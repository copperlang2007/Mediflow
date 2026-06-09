import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import { TrendingDown, AlertTriangle, ShieldAlert, Activity } from "lucide-react";

type Band = "high" | "medium" | "low";

interface ScoredMember {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  currentPlanType: string | null;
  lastActivityAt: string | null;
  score: number;
  band: Band;
  reasons: string[];
}

interface ChurnSummary {
  totalMembers: number;
  high: number;
  medium: number;
  low: number;
  averageScore: number;
}

const BAND_CONFIG: Record<Band, { label: string; className: string; bar: string }> = {
  high: { label: "High risk", className: "bg-red-100 text-red-800 border-red-200", bar: "bg-red-500" },
  medium: { label: "Medium", className: "bg-amber-100 text-amber-800 border-amber-200", bar: "bg-amber-500" },
  low: { label: "Low", className: "bg-green-100 text-green-800 border-green-200", bar: "bg-green-500" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ChurnRiskPage() {
  const [, navigate] = useLocation();
  const [band, setBand] = useState<"all" | Band>("all");

  const { data: summary } = useQuery({
    queryKey: ["churn", "summary"],
    queryFn: () => customFetch<ChurnSummary>("/api/churn/summary"),
    staleTime: 60_000,
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ["churn", "scores", band],
    queryFn: () =>
      customFetch<ScoredMember[]>(`/api/churn/scores${band !== "all" ? `?band=${band}` : ""}`),
  });

  const cards: Array<{ key: "all" | Band; label: string; value: number; icon: typeof ShieldAlert; className: string }> = [
    { key: "high", label: "High risk", value: summary?.high ?? 0, icon: AlertTriangle, className: "text-red-600" },
    { key: "medium", label: "Medium", value: summary?.medium ?? 0, icon: ShieldAlert, className: "text-amber-600" },
    { key: "low", label: "Low", value: summary?.low ?? 0, icon: Activity, className: "text-green-600" },
    { key: "all", label: "Avg score", value: summary?.averageScore ?? 0, icon: TrendingDown, className: "text-slate-600" },
  ];

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Churn Risk</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Current members ranked by disenrollment risk — work the riskiest book first
          </p>
        </div>
        <Badge variant="outline" className="text-xs">{summary?.totalMembers ?? 0} members</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          const selected = card.key !== "all" && band === card.key;
          return (
            <button
              key={card.key}
              onClick={() => card.key !== "all" && setBand((b) => (b === card.key ? "all" : (card.key as Band)))}
              className={`rounded-lg border p-4 text-left transition-all hover:shadow-sm ${selected ? "ring-2 ring-primary ring-offset-1" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</span>
                <Icon className={`h-4 w-4 ${card.className}`} />
              </div>
              <div className={`text-2xl font-bold mt-1 ${card.className}`}>{card.value}</div>
            </button>
          );
        })}
      </div>

      {band !== "all" && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setBand("all")}>
            Clear filter — showing {BAND_CONFIG[band].label}
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : (rows ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No members match the current filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((m) => {
            const cfg = BAND_CONFIG[m.band];
            const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || "Member";
            return (
              <Card key={m.contactId} className="cursor-pointer hover:shadow-sm transition-shadow" onClick={() => navigate(`/crm/contacts/${m.contactId}`)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{name}</span>
                        <Badge variant="outline" className={cfg.className}>{cfg.label}</Badge>
                        {m.currentPlanType && <Badge variant="outline">{m.currentPlanType}</Badge>}
                      </div>
                      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground mt-2">
                        <span>Last contact: {fmtDate(m.lastActivityAt)}</span>
                      </div>
                      {m.reasons.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-2">
                          {m.reasons.map((r, i) => (
                            <span key={i} className="text-[11px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{r}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-2xl font-bold ${m.band === "high" ? "text-red-600" : m.band === "medium" ? "text-amber-600" : "text-green-600"}`}>
                        {m.score}
                      </div>
                      <div className="w-24 h-1.5 rounded bg-muted mt-1 overflow-hidden">
                        <div className={`h-full ${cfg.bar}`} style={{ width: `${m.score}%` }} />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
