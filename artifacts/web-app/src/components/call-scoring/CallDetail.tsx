/**
 * One scored call: the result, every finding with its quote, speaker and
 * position (click "Jump to" to see the words in the transcript), human
 * override controls, and the do-not-contact requests found on the call.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusPill } from "@/components/shared";
import { AlertTriangle, LocateFixed, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { DncResolveControls } from "./DncResolveControls";
import { SpeakerRoleControls } from "./SpeakerRoleControls";
import {
  COMPLIANCE_TONE,
  CRITERION_TONE,
  QK,
  SEVERITY_LABEL,
  SPEAKER_LABEL,
  apiMessage,
  callLabel,
  fmtClock,
  fmtDate,
  outcomeOf,
  scoreCaveats,
  type CsCriterion,
  type CsDetail,
  type CsDncItem,
  type CsEvidence,
} from "./shared";

interface Jump {
  utterance: number;
  start: number | null;
  end: number | null;
  multi: boolean;
}

/**
 * The same resolution controls the queue shows, with the same data (numbers on
 * file, ambiguous clients, the email/phone channel), fetched for this call.
 */
function DetailDncControls({ transcriptId, findingId, contact }: { transcriptId: string; findingId: string; contact: { id: string; name: string } | null }) {
  const { data, isLoading } = useQuery({
    queryKey: [...QK, "dnc-for-call", transcriptId],
    queryFn: () => customFetch<{ items: CsDncItem[] }>(`/api/call-scoring/dnc-review?status=all&transcriptId=${encodeURIComponent(transcriptId)}&limit=200`),
  });
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  const item = data?.items.find((i) => i.findingId === findingId);
  return (
    <DncResolveControls
      findingId={findingId}
      contact={item?.contact ?? contact}
      candidates={item?.candidates ?? []}
      moreCandidates={item?.moreCandidates ?? false}
      numbers={item?.numbers ?? []}
      channel={item?.channel ?? "phone"}
      channelAssumed={item?.channelAssumed ?? false}
      emailOnFile={item?.emailOnFile ?? null}
    />
  );
}

/** Findings grouped by the rubric's sections, in rubric order; one unnamed group when it has none. */
function criteriaGroups(data: CsDetail): Array<{ id: string; name: string | null; criteria: CsCriterion[] }> {
  const sections = data.score?.rubric.sections ?? [];
  if (!sections.length) return [{ id: "all", name: null, criteria: data.criteria }];
  const groups = sections.map((s) => ({ id: s.id, name: s.name, criteria: data.criteria.filter((c) => c.sectionId === s.id) }));
  const other = data.criteria.filter((c) => !sections.some((s) => s.id === c.sectionId));
  if (other.length) groups.push({ id: "other", name: "Other", criteria: other });
  return groups.filter((g) => g.criteria.length);
}

function OverrideControls({ transcriptId, criterion }: { transcriptId: string; criterion: CsCriterion }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<"pass" | "partial" | "fail" | "na">("pass");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      customFetch(`/api/call-scoring/transcripts/${transcriptId}/criteria/${criterion.criterionId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success("Saved. The automatic result is unchanged and your decision is recorded.");
      setOpen(false);
      setNote("");
      void qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err) => toast.error(apiMessage(err, "Could not save that decision.")),
  });

  return (
    <div className="mt-3 border-t border-border pt-3">
      {!open ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {criterion.human ? "Change my grade" : criterion.status === "needs_review" ? "Grade this item" : "Override the grade"}
          </Button>
          {criterion.human && (
            <Button size="sm" variant="ghost" onClick={() => save.mutate({ verdict: "revert" })} disabled={save.isPending}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Go back to the automatic grade
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
            <div className="space-y-1">
              <Label className="text-xs">Your grade</Label>
              <Select value={verdict} onValueChange={(v) => setVerdict(v as typeof verdict)}>
                <SelectTrigger aria-label="Your grade" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass</SelectItem>
                  {!criterion.allOrNothing && <SelectItem value="partial">Partial</SelectItem>}
                  <SelectItem value="fail">Fail</SelectItem>
                  <SelectItem value="na">Not applicable</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`why-${criterion.criterionId}`} className="text-xs">Why? (required)</Label>
              <Textarea id={`why-${criterion.criterionId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate({ verdict, note: note.trim() })} disabled={save.isPending || note.trim().length < 3}>
              Save my grade
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Finding({
  c,
  onJump,
  canReview,
  transcriptId,
}: {
  c: CsCriterion;
  onJump: (e: CsEvidence) => void;
  canReview: boolean;
  transcriptId: string;
}) {
  const tone = CRITERION_TONE[c.status];
  const changed = c.human && c.autoStatus !== c.status;
  return (
    <li className="rounded-lg border border-border p-4" data-testid={`criterion-${c.criterionId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted-foreground">
            {c.allOrNothing ? "Auto-fail" : SEVERITY_LABEL[c.severity]}
            {c.points !== undefined ? ` · ${c.points} pt${c.points === 1 ? "" : "s"}` : ""}
            {c.citation ? ` · ${c.citation}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {changed && <StatusPill tone="neutral">Automatic: {CRITERION_TONE[c.autoStatus].label}</StatusPill>}
          <StatusPill tone={tone.tone}>{c.human ? `${tone.label} (reviewed)` : tone.label}</StatusPill>
        </div>
      </div>
      {c.rationale && <p className="mt-2 text-sm text-muted-foreground">{c.rationale}</p>}
      {c.evidence.length > 0 && (
        <ul className="mt-2 space-y-2">
          {c.evidence.map((e) => (
            <li key={e.findingId} className="rounded-md bg-muted/50 p-2.5 text-sm">
              <blockquote>“{e.quote ?? "(text no longer available)"}”</blockquote>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{SPEAKER_LABEL[e.speaker]}</span>
                {e.startSeconds !== null && <span>at {fmtClock(e.startSeconds)}</span>}
                <span>turn {e.utteranceIndex + 1}</span>
                <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => onJump(e)}>
                  <LocateFixed className="mr-1 h-3 w-3" />
                  Jump to it
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {c.evidence.length === 0 && c.status !== "na" && c.kind === "required" && (
        <p className="mt-2 text-xs text-muted-foreground">No words matching this requirement were found.</p>
      )}
      {c.autoFailNote && (c.status === "fail" || c.status === "partial") && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs font-medium text-destructive">{c.autoFailNote}</p>
      )}
      {c.coaching && c.status !== "pass" && <p className="mt-2 text-xs text-muted-foreground">Coaching: {c.coaching}</p>}
      {c.human && (
        <p className="mt-2 text-xs text-muted-foreground">
          {c.human.reviewerName ?? "A reviewer"} graded this {CRITERION_TONE[c.status].label.toLowerCase()} on {fmtDate(c.human.at)}
          {c.human.note ? `: “${c.human.note}”` : "."}
        </p>
      )}
      {canReview && <OverrideControls transcriptId={transcriptId} criterion={c} />}
    </li>
  );
}

function TranscriptPane({ detail, jump }: { detail: CsDetail; jump: Jump | null }) {
  if (!detail.transcript.textAvailable || detail.utterances.length === 0) {
    return <p className="text-sm text-muted-foreground">The transcript text is no longer available.</p>;
  }
  return (
    <ol className="space-y-2" aria-label="Transcript">
      {detail.utterances.map((u, i) => {
        const active = jump?.utterance === i;
        const s = active && jump?.start !== null && jump?.start !== undefined ? Math.min(jump.start, u.text.length) : 0;
        const e = active ? (jump?.multi || jump?.end == null ? u.text.length : Math.min(jump.end, u.text.length)) : 0;
        return (
          <li key={u.id} id={`cs-utt-${i}`} className={cn("rounded-md p-2 text-sm", active && "bg-warning/10 ring-1 ring-warning/40")}>
            <p className="mb-0.5 text-xs text-muted-foreground">
              {u.role === "unknown" ? u.speaker : SPEAKER_LABEL[u.role]} · {fmtClock(u.startSec)}
            </p>
            {active ? (
              <p>
                {u.text.slice(0, s)}
                <mark className="rounded bg-warning/40 px-0.5" data-testid="jump-highlight">
                  {u.text.slice(s, e)}
                </mark>
                {u.text.slice(e)}
              </p>
            ) : (
              <p>{u.text}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function CallDetail({ transcriptId, canReview, onClose }: { transcriptId: string | null; canReview: boolean; onClose: () => void }) {
  const [jump, setJump] = useState<Jump | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: [...QK, "detail", transcriptId],
    queryFn: () => customFetch<CsDetail>(`/api/call-scoring/transcripts/${transcriptId}`),
    enabled: Boolean(transcriptId),
  });

  const doJump = (e: CsEvidence) => {
    setJump({ utterance: e.utteranceIndex, start: e.startOffset, end: e.endOffset, multi: (e.endUtteranceIndex ?? e.utteranceIndex) !== e.utteranceIndex });
    requestAnimationFrame(() => document.getElementById(`cs-utt-${e.utteranceIndex}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  const score = data?.score ?? null;
  const caveats = data ? scoreCaveats(data) : [];

  return (
    <Sheet open={Boolean(transcriptId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-5xl">
        <SheetHeader>
          <SheetTitle>{data ? callLabel({ ...data.transcript }) : "Call"}</SheetTitle>
          <SheetDescription>
            {data
              ? `${data.transcript.agent ? `Agent ${data.transcript.agent.name} · ` : ""}${data.transcript.contact ? `Client ${data.transcript.contact.name} · ` : ""}${data.score?.rubric.name ?? ""}`
              : "Loading the call…"}
          </SheetDescription>
        </SheetHeader>

        {isLoading && <Skeleton className="mt-6 h-64 w-full" />}
        {isError && (
          <p role="alert" className="mt-6 text-sm text-destructive">
            This call could not be loaded. It may not exist, or it is not one of yours.
          </p>
        )}

        {data && score && (
          <div className="mt-4 space-y-5">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
              {score.rubric.outcomeLabels ? (
                <StatusPill tone={outcomeOf(score.rubric.outcomeLabels, score.effective).tone}>{outcomeOf(score.rubric.outcomeLabels, score.effective).label}</StatusPill>
              ) : (
                <StatusPill tone={COMPLIANCE_TONE[score.effective.compliance].tone}>{COMPLIANCE_TONE[score.effective.compliance].label}</StatusPill>
              )}
              <span className="font-display text-2xl font-bold">{score.effective.score}</span>
              <span className="text-sm text-muted-foreground">
                quality score{score.rubric.passThreshold !== null ? ` (target ${score.rubric.passThreshold})` : ""}
              </span>
              {score.effective.points && score.effective.points.possible > 0 && (
                <span className="text-sm text-muted-foreground" data-testid="score-points">
                  {score.effective.points.earned} / {score.effective.points.possible} points
                </span>
              )}
              {score.effective.compliance !== score.auto.compliance && (
                <span className="text-xs text-muted-foreground">Automatic result: {COMPLIANCE_TONE[score.auto.compliance].label}, {score.auto.score}</span>
              )}
              {score.effective.openDnc > 0 && <StatusPill tone="danger">{score.effective.openDnc} possible do-not-contact</StatusPill>}
              <span className="ml-auto text-xs text-muted-foreground">Scored {fmtDate(score.createdAt)}</span>
            </div>

            {canReview && <SpeakerRoleControls detail={data} />}

            {caveats.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm" aria-label="About this score">
                {caveats.map((c) => (
                  <li key={c} className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            )}

            {data.dnc.length > 0 && (
              <section aria-label="Possible do-not-contact requests" className="space-y-3">
                <h3 className="font-display text-base font-semibold">Possible do-not-contact requests</h3>
                {data.dnc.map((d) => (
                  <div key={d.findingId} className="rounded-lg border border-warning/40 p-4">
                    <p className="text-xs text-muted-foreground">
                      {SPEAKER_LABEL[d.speaker]}
                      {d.startSeconds !== null ? ` · at ${fmtClock(d.startSeconds)}` : ""}
                    </p>
                    <blockquote className="mt-1 text-sm font-medium">“{d.quote ?? "(text no longer available)"}”</blockquote>
                    {d.utteranceIndex !== null && (
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto p-0 text-xs"
                        onClick={() => doJump({ findingId: d.findingId, utteranceIndex: d.utteranceIndex!, endUtteranceIndex: d.utteranceIndex, startOffset: d.startOffset, endOffset: d.endOffset, startSeconds: d.startSeconds, speaker: d.speaker, quote: d.quote, componentId: null })}
                      >
                        <LocateFixed className="mr-1 h-3 w-3" />
                        Jump to it
                      </Button>
                    )}
                    <div className="mt-2">
                      {d.status === "open" ? (
                        canReview ? (
                          <DetailDncControls transcriptId={data.transcript.id} findingId={d.findingId} contact={data.transcript.contact} />
                        ) : (
                          <p className="text-sm text-muted-foreground">Waiting for a compliance reviewer.</p>
                        )
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {d.resolution?.action === "add_opt_out" ? "Added to the do-not-contact list" : "Dismissed"} by {d.resolution?.reviewerName ?? "a reviewer"} on {fmtDate(d.resolution?.at)}
                          {d.resolution?.note ? `: ${d.resolution.note}` : "."}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              <section aria-label="Findings" className="space-y-3">
                <h3 className="font-display text-base font-semibold">Findings</h3>
                {criteriaGroups(data).map((g) => (
                  <div key={g.id} className="space-y-3">
                    {g.name && <h4 className="text-sm font-semibold text-muted-foreground">{g.name}</h4>}
                    <ul className="space-y-3">
                      {g.criteria.map((c) => (
                        <Finding key={c.criterionId} c={c} onJump={doJump} canReview={canReview} transcriptId={data.transcript.id} />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
              <section aria-label="Transcript" className="space-y-3 lg:sticky lg:top-0 lg:max-h-[80vh] lg:self-start lg:overflow-y-auto">
                <h3 className="font-display text-base font-semibold">Transcript</h3>
                <TranscriptPane detail={data} jump={jump} />
              </section>
            </div>

            <p className="text-xs text-muted-foreground">{data.disclaimer}</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
