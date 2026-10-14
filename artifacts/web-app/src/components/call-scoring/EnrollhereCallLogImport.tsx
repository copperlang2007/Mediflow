/**
 * Import an EnrollHere call-log export (CSV). Every column of every call is
 * kept in Mediflow; calls with a recording are downloaded, transcribed and
 * scored in the background (they appear under "Recent recordings"). Importing
 * the same export again is safe and retries calls whose recording link had
 * expired.
 */
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MiniStat, SectionCard } from "@/components/shared";
import { CheckCircle2, Database, FileSpreadsheet, ListX, Loader2, Upload } from "lucide-react";
import { QK, apiMessage, type CsConfig } from "./shared";

const DEFAULT_RUBRIC = "iia-2026-qa";

interface CallLogRowResult {
  line: number;
  callId: string | null;
  outcome: string;
  message?: string;
}

export interface CallLogSummary {
  rows: number;
  stored: number;
  duplicates: number;
  queued: number;
  requeued: number;
  notScored: { short: number; noRecording: number; badLink: number; notTranscribed: number };
  errors: number;
  unreadable: string[];
  results: CallLogRowResult[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function EnrollhereCallLogImport({ config }: { config: CsConfig | undefined }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rubricId, setRubricId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [out, setOut] = useState<CallLogSummary | null>(null);
  const rubrics = config?.rubrics ?? [];
  const chosenRubric = rubricId || (rubrics.some((r) => r.id === DEFAULT_RUBRIC) ? DEFAULT_RUBRIC : (config?.defaultRubricId ?? ""));

  const run = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      if (chosenRubric) fd.append("rubricId", chosenRubric);
      return customFetch<CallLogSummary>("/api/call-scoring/enrollhere-call-log", { method: "POST", body: fd });
    },
    onSuccess: (data) => {
      setOut(data);
      setProblem(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void qc.invalidateQueries({ queryKey: [...QK, "recordings"] });
    },
    onError: (err) => setProblem(apiMessage(err, "The call log could not be imported.")),
  });

  const problems = out?.results.filter((r) => r.outcome === "error" || r.outcome === "stored_bad_link") ?? [];

  return (
    <SectionCard
      title="Import an EnrollHere call log"
      description="Upload the call-log CSV exported from EnrollHere. Every column of every call is kept in Mediflow (encrypted, 10 years). Calls with a recording are downloaded, transcribed and scored automatically."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          setProblem(null);
          run.mutate(file);
        }}
      >
        {!config?.audio.supported && (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Audio transcription is not set up yet, so calls will be stored but not scored. Import the same file again once it is set up.</span>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-calllog-file">Call-log CSV</Label>
            <Input id="cs-calllog-file" ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">Recording links expire a few days after export, so import each export the same day.</p>
          </div>
          {rubrics.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="cs-calllog-rubric">Checklist</Label>
              <Select value={chosenRubric} onValueChange={setRubricId}>
                <SelectTrigger id="cs-calllog-rubric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rubrics.map((rb) => (
                    <SelectItem key={rb.id} value={rb.id}>
                      {rb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <Button type="submit" disabled={!file || run.isPending}>
          {run.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />}
          {run.isPending ? "Importing…" : "Import call log"}
        </Button>
      </form>

      {out && (
        <div className="mt-5 space-y-4" data-testid="call-log-result">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniStat label="Calls in file" value={out.rows} icon={FileSpreadsheet} />
            <MiniStat label="New calls stored" value={out.stored} icon={Database} tone="success" />
            <MiniStat label="Sent for scoring" value={out.queued + out.requeued} icon={CheckCircle2} tone={out.queued + out.requeued ? "success" : "default"} />
            <MiniStat label="Could not import" value={out.errors + out.unreadable.length} icon={ListX} tone={out.errors + out.unreadable.length ? "danger" : "default"} />
          </div>
          <p className="text-sm text-muted-foreground">
            {out.duplicates > 0 ? `${plural(out.duplicates, "call")} already imported earlier (skipped). ` : ""}
            {out.requeued > 0 ? `${plural(out.requeued, "earlier call")} sent for scoring again. ` : ""}
            {out.notScored.short > 0 ? `${plural(out.notScored.short, "call")} under a minute (stored, not scored). ` : ""}
            {out.notScored.noRecording > 0 ? `${plural(out.notScored.noRecording, "call")} without a recording (stored). ` : ""}
            {out.notScored.notTranscribed > 0 ? `${plural(out.notScored.notTranscribed, "call")} stored but not scored: audio transcription is not set up. ` : ""}
            {out.queued + out.requeued > 0 ? "Scoring runs in the background; follow it under Recent recordings." : ""}
          </p>
          {(problems.length > 0 || out.unreadable.length > 0) && (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm" aria-label="Rows with problems">
              {out.unreadable.map((u) => (
                <li key={u} className="p-3 text-muted-foreground">
                  {u}
                </li>
              ))}
              {problems.map((r) => (
                <li key={`${r.line}-${r.callId}`} className="p-3">
                  <span className="font-medium">Line {r.line}</span>
                  {r.callId ? <span className="text-muted-foreground"> · call {r.callId}</span> : null}
                  {r.message && <span className="block text-xs text-muted-foreground">{r.message}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}
