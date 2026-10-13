/**
 * One-track recordings are split by voice ("Speaker 1", "Speaker 2") and the
 * app never guesses which voice is the agent. This lets a reviewer say so; the
 * call is then scored again with the right person on each line.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { QK, apiMessage, fmtDate, type CsDetail } from "./shared";

const SNIPPET = 90;

function firstWords(detail: CsDetail, label: string): string {
  const turn = detail.utterances.find((u) => u.speaker === label);
  const text = turn?.text.trim() ?? "";
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET).trimEnd()}…` : text;
}

export function SpeakerRoleControls({ detail }: { detail: CsDetail }) {
  const qc = useQueryClient();
  const info = detail.transcript.speakers;
  const rubricId = detail.score?.rubric.id;
  const choose = useMutation({
    mutationFn: (agentSpeaker: string) =>
      customFetch(`/api/call-scoring/transcripts/${detail.transcript.id}/agent-speaker`, {
        method: "POST",
        body: JSON.stringify({ agentSpeaker, ...(rubricId ? { rubricId } : {}) }),
      }),
    onSuccess: () => {
      toast.success("Saved. The call was scored again with that voice as the agent. The earlier result is kept in the history.");
      void qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err) => toast.error(apiMessage(err, "That did not work. Nothing was changed.")),
  });

  if (!info?.assignable) return null;
  const assigned = detail.transcript.speakerAssignedAt;

  return (
    <section aria-label="Who is the agent" className="rounded-lg border border-border bg-muted/30 p-3 text-sm" data-testid="speaker-roles">
      <p className="font-medium">{assigned ? "Who is the agent on this call?" : "Which voice is the agent?"}</p>
      <p className="mt-1 text-muted-foreground">
        {assigned
          ? `A reviewer chose this on ${fmtDate(assigned)}. If it is wrong, pick the other voice and the call is scored again.`
          : "This recording has one audio track, so the voices could only be told apart, not named. Pick the agent and the call is scored again with the right person on each line."}
      </p>
      <ul className="mt-3 space-y-2">
        {info.speakers.map((s) => (
          <li key={s.label} className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant={s.role === "agent" ? "default" : "outline"}
              disabled={choose.isPending || s.role === "agent"}
              onClick={() => choose.mutate(s.label)}
              aria-label={`${s.label} is the agent`}
            >
              {s.label} is the agent
            </Button>
            <span className="text-xs text-muted-foreground">
              {s.turns} {s.turns === 1 ? "turn" : "turns"}
              {firstWords(detail, s.label) ? ` · starts “${firstWords(detail, s.label)}”` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
