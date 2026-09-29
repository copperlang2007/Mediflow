/**
 * Paste or upload one transcript, or import a batch for the look-back.
 * Text transcripts only: audio can't be transcribed yet, and this says so
 * instead of pretending.
 */
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MiniStat, SectionCard, StatusPill } from "@/components/shared";
import { AlertTriangle, CheckCircle2, FileAudio, PhoneOff, Upload } from "lucide-react";
import { COMPLIANCE_TONE, QK, apiMessage, type CsConfig, type Compliance } from "./shared";

interface ScoreSummary {
  transcriptId: string;
  score: number;
  compliance: Compliance;
  dncFlagCount: number;
  notes: Array<{ code: string; message: string }>;
}

interface ImportResponse {
  summary: {
    files: number;
    scored: number;
    duplicates: number;
    errors: number;
    byCompliance: Record<Compliance, number>;
    possibleDncFiles: number;
    possibleDncRequests: number;
    unlabelledSpeakers: number;
    needContactPick: number;
    notLinkedToClient: number;
    manifest: { rows: number; unmatchedManifestRows: number; problems: string[] } | null;
    aiReview: string;
    note: string;
  };
  results: Array<{ filename: string; status: "scored" | "duplicate" | "error"; compliance?: Compliance; score?: number; dncFlags?: number; error?: string; warnings: string[] }>;
}

function AudioNote({ config }: { config: CsConfig | undefined }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
      <FileAudio className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{config?.audio.message ?? "Audio transcription is not set up yet. Upload a transcript (TXT, VTT, SRT or JSON)."}</span>
    </p>
  );
}

function SingleUpload({ config, onOpen, onDone }: { config: CsConfig | undefined; onOpen: (id: string) => void; onDone: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phone, setPhone] = useState("");
  const [ref, setRef] = useState("");
  const [rubricId, setRubricId] = useState<string>("");
  const [result, setResult] = useState<ScoreSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const aiReady = config?.ai.status === "configured";

  const submit = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (file) fd.append("file", file);
      else fd.append("text", text);
      if (phone.trim()) fd.append("phone", phone.trim());
      if (ref.trim()) fd.append("externalRef", ref.trim());
      if (rubricId) fd.append("rubricId", rubricId);
      return customFetch<ScoreSummary>("/api/call-scoring/transcripts", { method: "POST", body: fd });
    },
    onSuccess: (res) => {
      setResult(res);
      setProblem(null);
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Scored. Open the call to see every finding.");
      void qc.invalidateQueries({ queryKey: QK });
      onDone();
    },
    onError: (err) => {
      setResult(null);
      const data = (err as { data?: { transcriptId?: string } }).data;
      setProblem(apiMessage(err, "That transcript could not be scored."));
      if (data?.transcriptId) setResult(null);
    },
  });

  return (
    <SectionCard
      title="Score one transcript"
      description="Paste the text or upload a TXT, VTT, SRT or JSON file. Rule checks and the do-not-contact check run right away."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          submit.mutate();
        }}
      >
        <AudioNote config={config} />
        <div className="space-y-1.5">
          <Label htmlFor="cs-paste">Transcript text</Label>
          <Textarea
            id="cs-paste"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            disabled={Boolean(file)}
            maxLength={config?.limits.maxPasteChars ?? 500_000}
            placeholder={"Agent: Thank you for calling…\nCustomer: Hi, I have a question…"}
          />
          <p className="text-xs text-muted-foreground">Label turns with “Agent:” and “Customer:” when you can. Without labels, every turn is treated as an unknown speaker and the score says so.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-file">…or upload a file</Label>
            <Input
              id="cs-file"
              ref={fileRef}
              type="file"
              accept=".txt,.vtt,.srt,.json,text/plain,application/json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-rubric">Checklist</Label>
            <Select value={rubricId || config?.defaultRubricId || ""} onValueChange={setRubricId}>
              <SelectTrigger id="cs-rubric">
                <SelectValue placeholder="Medicare sales call" />
              </SelectTrigger>
              <SelectContent>
                {(config?.rubrics ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-phone">Client phone number (optional)</Label>
            <Input id="cs-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(310) 555-0100" />
            <p className="text-xs text-muted-foreground">Used to link the call to a client, only when exactly one client has this number.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-ref">Reference (optional)</Label>
            <Input id="cs-ref" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} placeholder="Recording ID" />
            <p className="text-xs text-muted-foreground">Don’t put a client’s name here.</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {aiReady
            ? "AI review is set up: PHI-redacted text is sent to the HIPAA-covered AI provider for the judgment items."
            : "AI review is not set up, so judgment items will be marked needs review."}
        </p>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <Button type="submit" disabled={submit.isPending || (!file && !text.trim())}>
          <Upload className="mr-1.5 h-4 w-4" />
          {submit.isPending ? "Scoring…" : "Score transcript"}
        </Button>
      </form>

      {result && (
        <div className="mt-5 rounded-lg border border-border p-4" data-testid="single-result">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={COMPLIANCE_TONE[result.compliance].tone}>{COMPLIANCE_TONE[result.compliance].label}</StatusPill>
            <span className="font-display text-xl font-bold">{result.score}</span>
            {result.dncFlagCount > 0 && <StatusPill tone="danger">{result.dncFlagCount} possible do-not-contact</StatusPill>}
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => onOpen(result.transcriptId)}>
              Open the call
            </Button>
          </div>
          {result.notes.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              {result.notes.map((n) => (
                <li key={n.code}>{n.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function BulkImport({ config, onShowDnc }: { config: CsConfig | undefined; onShowDnc: () => void }) {
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<File | null>(null);
  const [out, setOut] = useState<ImportResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const max = config?.limits.maxImportFiles ?? 50;

  const run = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      if (manifest) fd.append("manifest", manifest);
      fd.append("source", "enrollhere_download");
      return customFetch<ImportResponse>("/api/call-scoring/import", { method: "POST", body: fd });
    },
    onSuccess: (res) => {
      setOut(res);
      setProblem(null);
      setFiles([]);
      setManifest(null);
      void qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err) => setProblem(apiMessage(err, "The import could not run. Nothing was scored.")),
  });

  return (
    <SectionCard
      title="Look-back import"
      description={`Score a batch of transcripts (up to ${max} files at a time) with rules only. Possible do-not-contact requests land in the review queue; nothing is added to the list automatically.`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          run.mutate();
        }}
      >
        <AudioNote config={config} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-import-files">Transcript files</Label>
            <Input
              id="cs-import-files"
              type="file"
              multiple
              accept=".txt,.vtt,.srt,.json"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <p className="text-xs text-muted-foreground">
              {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} chosen` : "TXT, VTT, SRT or JSON"}
              {files.length > max ? ` — too many, choose at most ${max}` : ""}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-import-manifest">Manifest (optional CSV)</Label>
            <Input id="cs-import-manifest" type="file" accept=".csv,text/csv" onChange={(e) => setManifest(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">
              Columns: <code>filename</code> (required), <code>phone</code>, <code>contactId</code>, <code>agent</code> (id, email or full name), <code>date</code>, <code>reference</code>.
            </p>
          </div>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <Button type="submit" disabled={run.isPending || files.length === 0 || files.length > max}>
          <Upload className="mr-1.5 h-4 w-4" />
          {run.isPending ? "Scoring…" : "Import and score"}
        </Button>
      </form>

      {out && (
        <div className="mt-5 space-y-4" data-testid="import-result">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniStat label="Files scored" value={`${out.summary.scored} of ${out.summary.files}`} icon={CheckCircle2} tone="success" />
            <MiniStat label="Need review" value={out.summary.byCompliance.review} icon={AlertTriangle} tone={out.summary.byCompliance.review ? "warning" : "default"} />
            <MiniStat label="Failed" value={out.summary.byCompliance.fail} icon={AlertTriangle} tone={out.summary.byCompliance.fail ? "danger" : "default"} />
            <MiniStat label="Possible do-not-contact" value={out.summary.possibleDncRequests} icon={PhoneOff} tone={out.summary.possibleDncRequests ? "danger" : "default"} />
          </div>
          <p className="text-sm text-muted-foreground">
            {out.summary.duplicates > 0 ? `${out.summary.duplicates} already scored earlier (skipped). ` : ""}
            {out.summary.errors > 0 ? `${out.summary.errors} could not be scored. ` : ""}
            {out.summary.unlabelledSpeakers > 0 ? `${out.summary.unlabelledSpeakers} have no speaker labels. ` : ""}
            {out.summary.needContactPick > 0 ? `${out.summary.needContactPick} match more than one client by phone. ` : ""}
            {out.summary.manifest && out.summary.manifest.unmatchedManifestRows > 0 ? `${out.summary.manifest.unmatchedManifestRows} manifest rows had no file. ` : ""}
            {out.summary.aiReview}
          </p>
          {out.summary.possibleDncRequests > 0 && (
            <Button size="sm" onClick={onShowDnc}>
              Review the {out.summary.possibleDncRequests} possible do-not-contact request{out.summary.possibleDncRequests === 1 ? "" : "s"}
            </Button>
          )}
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {out.results.map((r, i) => (
              <li key={`${r.filename}-${i}`} className="flex flex-wrap items-center gap-2 p-3">
                <span className="min-w-0 flex-1 truncate font-medium">{r.filename}</span>
                {r.status === "scored" && r.compliance ? (
                  <>
                    <StatusPill tone={COMPLIANCE_TONE[r.compliance].tone}>{COMPLIANCE_TONE[r.compliance].label}</StatusPill>
                    <span className="text-muted-foreground">score {r.score}</span>
                    {(r.dncFlags ?? 0) > 0 && <StatusPill tone="danger">do-not-contact?</StatusPill>}
                  </>
                ) : (
                  <StatusPill tone={r.status === "duplicate" ? "neutral" : "danger"}>{r.status === "duplicate" ? "Already scored" : "Not scored"}</StatusPill>
                )}
                {r.error && <span className="basis-full text-xs text-muted-foreground">{r.error}</span>}
                {r.warnings.map((w) => (
                  <span key={w} className="basis-full text-xs text-muted-foreground">
                    {w}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

export function AddTranscripts({
  config,
  onOpen,
  onShowDnc,
}: {
  config: CsConfig | undefined;
  onOpen: (id: string) => void;
  onShowDnc: () => void;
}) {
  return (
    <div className="space-y-6">
      <SingleUpload config={config} onOpen={onOpen} onDone={() => undefined} />
      <BulkImport config={config} onShowDnc={onShowDnc} />
    </div>
  );
}
