import { useState, useRef, useEffect } from "react";
import { useGetAuditLog } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Activity, Clock, Sparkles, Loader2, ChevronDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@clerk/react";
import { cn } from "@/lib/utils";

function AiComplianceReport() {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [report]);

  const generate = async () => {
    setReport("");
    setError(null);
    setStreaming(true);
    setOpen(true);
    try {
      const token = await getToken();
      const res = await fetch(`${base}/api/ai/compliance-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });
      if (!res.ok || !res.body) throw new Error("Request failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let isDone = false;
      while (!isDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") { isDone = true; break; }
            try {
              const ev = JSON.parse(raw) as { content?: string; done?: boolean; error?: string };
              if (ev.done) { isDone = true; break; }
              if (ev.content) {
                setReport((prev) => (prev ?? "") + ev.content);
              } else if (ev.error) {
                setError(ev.error);
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to generate report");
    } finally {
      setStreaming(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Compliance Report
          </CardTitle>
          <Button size="sm" onClick={generate} disabled={streaming}>
            {streaming ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Generating…</>
            ) : (
              <><Sparkles className="h-3.5 w-3.5 mr-1.5" />Generate Report</>
            )}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div
              ref={scrollRef}
              className={cn(
                "rounded-lg bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap max-h-96 overflow-y-auto leading-relaxed",
                streaming && "border border-primary/20"
              )}
            >
              {report || <span className="text-muted-foreground">Analyzing compliance data…</span>}
              {streaming && <span className="animate-pulse">▌</span>}
            </div>
          )}
          <button
            className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setOpen(false)}
          >
            <ChevronDown className="h-3 w-3" />
            Collapse
          </button>
        </CardContent>
      )}
    </Card>
  );
}

export default function CompliancePage() {
  const { data, isLoading } = useGetAuditLog({});

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Audit & Compliance</h1>
        <p className="text-sm text-muted-foreground mt-0.5">HIPAA audit trail and compliance monitoring</p>
      </div>

      <AiComplianceReport />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Audit Log
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (data?.entries ?? []).length === 0 ? (
            <div className="py-14 text-center">
              <ShieldCheck className="h-12 w-12 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">No audit events recorded yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(data?.entries ?? []).map((entry) => (
                <div key={entry.id} className="flex items-start gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors">
                  <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-[11px]">{entry.resourceType}</Badge>
                      <span className="text-sm font-medium">{entry.action}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {entry.userFullName ?? entry.userId ?? "System"}
                      {entry.userRole && ` · ${entry.userRole}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                    <Clock className="h-3 w-3" />
                    {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
