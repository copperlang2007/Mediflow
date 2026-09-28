import { useState, useRef, useEffect } from "react";
import { useGetAuditLog } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Activity, Clock, Sparkles, Loader2, ChevronDown, Download } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@clerk/react";
import { cn } from "@/lib/utils";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState, type StatusTone } from "@/components/shared";
import { PageShell, KpiGrid } from "@/components/ops";
import { FilePen, Users } from "lucide-react";

function AiComplianceReport() {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
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
    setDocumentId(null);
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
              const ev = JSON.parse(raw) as { content?: string; done?: boolean; documentId?: string; error?: string };
              if (ev.done) {
                if (ev.documentId) setDocumentId(ev.documentId);
                isDone = true;
                break;
              }
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

  const downloadReport = async () => {
    if (!documentId) return;
    const token = await getToken();
    const url = `${base}/api/ai/compliance-report/${documentId}`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: "follow",
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `compliance-report-${documentId}.pdf`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="font-display text-lg font-semibold">AI compliance report</CardTitle>
              <p className="text-sm text-muted-foreground">A plain-English summary of each agent's licenses, certifications, AHIP and overdue tasks, with a PDF copy</p>
            </div>
          </div>
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
          <div className="mt-2 flex items-center gap-3">
            {documentId && !streaming && (
              <Button size="sm" variant="outline" onClick={downloadReport} className="h-7 text-xs gap-1.5">
                <Download className="h-3 w-3" />
                Download PDF
              </Button>
            )}
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setOpen(false)}
            >
              <ChevronDown className="h-3 w-3" />
              Collapse
            </button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

const ACTION_TONES: Record<string, StatusTone> = {
  create: "success",
  update: "info",
  delete: "danger",
  read: "neutral",
  export: "warning",
  login: "navy",
};

function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export default function CompliancePage() {
  const { data, isLoading } = useGetAuditLog({});
  const entries = data?.entries ?? [];
  const people = new Set(entries.map((e) => e.userId ?? "system")).size;
  const changes = entries.filter((e) => e.action !== "read").length;
  const latest = entries[0];

  return (
    <PageShell>
      <PageHeader
        title="Audit & Compliance"
        subtitle="A permanent record of who looked at or changed what — the HIPAA audit trail"
      />

      <KpiGrid>
        <KpiCard
          label="Events recorded"
          value={data?.total ?? 0}
          icon={Activity}
          color="navy"
          loading={isLoading}
          hint="All time, for your agency"
        />
        <KpiCard
          label="Changes in this view"
          value={changes}
          icon={FilePen}
          color="blue"
          loading={isLoading}
          hint={`Of the latest ${entries.length} events`}
        />
        <KpiCard
          label="People in this view"
          value={people}
          icon={Users}
          color="green"
          loading={isLoading}
          hint="Different users behind these events"
        />
        <KpiCard
          label="Most recent"
          value={<span className="block text-xl leading-snug pt-1.5">{latest ? formatDistanceToNow(new Date(latest.createdAt), { addSuffix: true }) : "—"}</span>}
          icon={Clock}
          color="orange"
          loading={isLoading}
          hint={latest ? `${humanize(latest.action)} · ${humanize(latest.resourceType)}` : "Nothing recorded yet"}
        />
      </KpiGrid>

      <AiComplianceReport />

      <SectionCard
        title="Audit log"
        description="Newest first. Entries can't be edited or deleted."
        icon={ShieldCheck}
      >
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No audit events recorded yet"
              description="As soon as someone views or changes client, agent or commission records, each action is logged here automatically."
            />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-start gap-4 px-4 py-3.5 hover:bg-muted/30 transition-colors">
                  <div className="h-9 w-9 rounded-full bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground flex items-center justify-center shrink-0 text-xs font-semibold">
                    {(entry.userFullName ?? "S").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{entry.userFullName ?? entry.userId ?? "System"}</span>
                      <StatusPill tone={ACTION_TONES[entry.action] ?? "neutral"}>{humanize(entry.action)}</StatusPill>
                      <span className="text-sm text-muted-foreground">{humanize(entry.resourceType)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {entry.userRole ? humanize(entry.userRole) : "Automated"}
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
      </SectionCard>
    </PageShell>
  );
}
