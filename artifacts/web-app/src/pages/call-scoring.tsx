import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid, FilterBar } from "@/components/ops";
import { AlertTriangle, ClipboardCheck, FileAudio, PhoneOff, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { AddTranscripts } from "@/components/call-scoring/AddTranscripts";
import { CallDetail } from "@/components/call-scoring/CallDetail";
import { DncQueue } from "@/components/call-scoring/DncQueue";
import {
  COMPLIANCE_TONE,
  PAGE_SIZE,
  Pager,
  QK,
  callLabel,
  fmtDate,
  type CsConfig,
  type CsList,
  type CsSummary,
} from "@/components/call-scoring/shared";

const REVIEW_ROLES = ["super_admin", "agency_admin", "compliance_manager"];

function Capabilities({ config, loading }: { config: CsConfig | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-16 w-full" />;
  return (
    <SectionCard contentClassName="!p-4">
      <ul className="grid gap-3 text-sm sm:grid-cols-3" aria-label="What is set up">
        <li className="flex items-start gap-2">
          <FileAudio className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="flex items-center gap-2 font-medium">
              Audio transcription{" "}
              {config?.audio.supported ? <StatusPill tone="success">Set up</StatusPill> : <StatusPill tone="neutral">Not set up</StatusPill>}
            </p>
            <p className="text-xs text-muted-foreground">
              {config?.audio.supported
                ? "Recordings are transcribed with Google Speech-to-Text, then scored."
                : "Score transcripts (TXT, VTT, SRT, JSON) for now. Nothing is transcribed or guessed."}
            </p>
          </div>
        </li>
        <li className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="flex items-center gap-2 font-medium">
              AI review{" "}
              {config?.ai.status === "configured" ? <StatusPill tone="success">Set up</StatusPill> : <StatusPill tone="warning">Not set up</StatusPill>}
            </p>
            <p className="text-xs text-muted-foreground">
              {config?.ai.status === "configured"
                ? "Judgment items are graded by the HIPAA-covered AI from PHI-redacted text."
                : "Judgment items are marked needs review. Rule checks and the do-not-contact check still run."}
            </p>
          </div>
        </li>
        <li className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">Assists review</p>
            <p className="text-xs text-muted-foreground">{config?.disclaimer ?? "Not legal advice and not a compliance certification."}</p>
          </div>
        </li>
      </ul>
    </SectionCard>
  );
}

export default function CallScoringPage() {
  const { data: me } = useGetMe();
  const role = (me as { role?: string } | undefined)?.role ?? "";
  const [tab, setTab] = useState("calls");
  const [openId, setOpenId] = useState<string | null>(null);
  const [compliance, setCompliance] = useState<"all" | "pass" | "fail" | "review">("all");
  const [rubricId, setRubricId] = useState("all");
  const [dncOnly, setDncOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  // Any filter change starts again from the first page.
  const changeFilter = <T,>(set: (v: T) => void) => (v: T) => {
    setOffset(0);
    set(v);
  };

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: [...QK, "config"],
    queryFn: () => customFetch<CsConfig>("/api/call-scoring/config"),
    staleTime: 60_000,
  });
  const canReview = config?.canReview ?? REVIEW_ROLES.includes(role);
  const canCreate = config?.canCreate ?? REVIEW_ROLES.includes(role);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: [...QK, "summary"],
    queryFn: () => customFetch<CsSummary>("/api/call-scoring/summary"),
    staleTime: 15_000,
  });

  const { data: list, isLoading: listLoading, isError: listError } = useQuery({
    queryKey: [...QK, "list", compliance, rubricId, dncOnly, offset],
    queryFn: () => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (compliance !== "all") p.set("compliance", compliance);
      if (rubricId !== "all") p.set("rubricId", rubricId);
      if (dncOnly) p.set("dnc", "open");
      return customFetch<CsList>(`/api/call-scoring/transcripts?${p.toString()}`);
    },
  });

  const totals = summary?.totals;
  const filtered = compliance !== "all" || rubricId !== "all" || dncOnly;

  return (
    <PageShell>
      <PageHeader
        title="Call scoring"
        subtitle="Check call transcripts against your compliance checklist and catch possible do-not-contact requests. Assists review, not legal advice."
      >
        {canCreate && (
          <Button onClick={() => setTab("add")}>Add transcripts</Button>
        )}
      </PageHeader>

      <Capabilities config={config} loading={configLoading} />

      <KpiGrid>
        <KpiCard
          label="Calls scored"
          value={totals?.total ?? 0}
          icon={ClipboardCheck}
          color="navy"
          loading={summaryLoading}
          hint={totals && totals.total === 0 ? "Nothing scored yet" : totals?.avgScore !== null && totals ? `Average quality score ${totals.avgScore}` : undefined}
        />
        <button type="button" className="text-left" onClick={() => {
          setOffset(0);
          setCompliance((c) => (c === "review" ? "all" : "review"));
        }} aria-pressed={compliance === "review"}>
          <KpiCard
            label="Needs review"
            value={totals?.review ?? 0}
            icon={AlertTriangle}
            color="orange"
            loading={summaryLoading}
            hint={totals && totals.review === 0 ? "Nothing waiting on a person" : "Click to show only these"}
          />
        </button>
        <button type="button" className="text-left" onClick={() => {
          setOffset(0);
          setCompliance((c) => (c === "fail" ? "all" : "fail"));
        }} aria-pressed={compliance === "fail"}>
          <KpiCard
            label="Failed compliance"
            value={totals?.fail ?? 0}
            icon={XCircle}
            color="blue"
            loading={summaryLoading}
            hint={totals && totals.fail === 0 ? "No failed calls" : "Click to show only these"}
          />
        </button>
        <button
          type="button"
          className="text-left"
          onClick={() => {
            if (canReview) setTab("dnc");
          }}
        >
          <KpiCard
            label="Possible do-not-contact"
            value={totals?.openDnc ?? 0}
            icon={PhoneOff}
            color="green"
            loading={summaryLoading}
            hint={totals && totals.openDnc === 0 ? "None waiting for a decision" : canReview ? "Click to review them" : "Waiting for a compliance reviewer"}
          />
        </button>
      </KpiGrid>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="calls">Calls</TabsTrigger>
          {canReview && (
            <TabsTrigger value="dnc">
              Possible do-not-contact requests{totals && totals.openDnc > 0 ? ` (${totals.openDnc})` : ""}
            </TabsTrigger>
          )}
          {canCreate && <TabsTrigger value="add">{config?.audio.supported ? "Add calls" : "Add transcripts"}</TabsTrigger>}
        </TabsList>

        <TabsContent value="calls" className="mt-4">
          <SectionCard title="Scored calls" description="Newest first. Open a call to see each finding with the exact words, who said them and where.">
            <FilterBar>
              <Select value={compliance} onValueChange={(v) => changeFilter(setCompliance)(v as typeof compliance)}>
                <SelectTrigger className="h-9 w-[170px]" aria-label="Result">
                  <SelectValue placeholder="Result" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Every result</SelectItem>
                  <SelectItem value="pass">Passed</SelectItem>
                  <SelectItem value="review">Needs review</SelectItem>
                  <SelectItem value="fail">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={rubricId} onValueChange={changeFilter(setRubricId)}>
                <SelectTrigger className="h-9 w-[230px]" aria-label="Checklist">
                  <SelectValue placeholder="Checklist" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Every checklist</SelectItem>
                  {(config?.rubrics ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant={dncOnly ? "default" : "outline"} size="sm" onClick={() => {
                  setOffset(0);
                  setDncOnly((v) => !v);
                }} aria-pressed={dncOnly}>
                <PhoneOff className="mr-1.5 h-3.5 w-3.5" />
                Possible do-not-contact only
              </Button>
            </FilterBar>

            {listLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : listError ? (
              <p role="alert" className="text-sm text-destructive">
                The calls could not be loaded.
              </p>
            ) : !list || list.items.length === 0 ? (
              filtered ? (
                <EmptyState icon={ClipboardCheck} title="No calls match these filters." description="Try a different result or checklist." />
              ) : (
                <EmptyState
                  icon={ClipboardCheck}
                  title="No calls scored yet"
                  description={
                    canCreate
                      ? "Add a transcript (or a batch for the look-back) and every call is checked against your checklist and for do-not-contact requests."
                      : "When a compliance reviewer scores your calls, the ones you placed will show up here."
                  }
                  action={canCreate ? { label: "Add transcripts", onClick: () => setTab("add") } : undefined}
                />
              )
            ) : (
              <>
                <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Scored calls">
                  {list.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setOpenId(item.id)}
                        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{callLabel(item)}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.agent ? `Agent ${item.agent.name}` : "No agent set"} · {item.contact ? item.contact.name : "Not linked to a client"} · {fmtDate(item.callDate ?? item.createdAt)}
                          </span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          {item.openDnc > 0 && <StatusPill tone="danger">Do-not-contact?</StatusPill>}
                          {item.needsReviewCount > 0 && <span className="text-xs text-muted-foreground">{item.needsReviewCount} to review</span>}
                          <span className="w-8 text-right font-display font-semibold">{item.score}</span>
                          <StatusPill tone={COMPLIANCE_TONE[item.compliance].tone}>{COMPLIANCE_TONE[item.compliance].label}</StatusPill>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <Pager offset={offset} total={list.total} shown={list.items.length} onChange={setOffset} label="Scored calls" />
                {list.truncated && (
                  <p className="mt-2 text-xs text-muted-foreground">There are more matching calls than can be listed here. Use the filters to narrow down.</p>
                )}
              </>
            )}
          </SectionCard>

          {summary && summary.byAgent.length > 0 && (
            <SectionCard className="mt-6" title="By agent" description="Human-reviewed results, from real scored calls.">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-4 font-semibold">Agent</th>
                      <th className="py-1 pr-4 font-semibold">Calls</th>
                      <th className="py-1 pr-4 font-semibold">Passed</th>
                      <th className="py-1 pr-4 font-semibold">Needs review</th>
                      <th className="py-1 pr-4 font-semibold">Failed</th>
                      <th className="py-1 font-semibold">Average score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byAgent.map((a) => (
                      <tr key={a.agentId ?? "none"} className="border-t border-border">
                        <td className="py-1.5 pr-4">{a.name ?? "No agent set"}</td>
                        <td className="py-1.5 pr-4">{a.total}</td>
                        <td className="py-1.5 pr-4">{a.pass}</td>
                        <td className="py-1.5 pr-4">{a.review}</td>
                        <td className="py-1.5 pr-4">{a.fail}</td>
                        <td className="py-1.5">{a.avgScore ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </TabsContent>

        {canReview && (
          <TabsContent value="dnc" className="mt-4">
            <DncQueue onOpenCall={setOpenId} />
          </TabsContent>
        )}
        {canCreate && (
          <TabsContent value="add" className="mt-4">
            <AddTranscripts config={config} onOpen={setOpenId} onShowDnc={() => setTab("dnc")} />
          </TabsContent>
        )}
      </Tabs>

      <CallDetail transcriptId={openId} canReview={canReview} onClose={() => setOpenId(null)} />
    </PageShell>
  );
}
