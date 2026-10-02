/**
 * Upload a call recording (an ENROLLHERE download or any dialer's export) to
 * be transcribed by Google Speech-to-Text and then scored like any transcript.
 *
 * The file goes straight from the browser to the private bucket with a
 * short-lived signed URL (routes/callScoring.ts), so long calls are fine; the
 * server then queues transcription. Status below refreshes while work is
 * pending.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard, StatusPill, type StatusTone } from "@/components/shared";
import { FileAudio, Loader2, Upload } from "lucide-react";
import { QK, apiMessage, fmtDate, type CsConfig } from "./shared";

type Layout = string;
type RecordingStatus = "uploading" | "queued" | "transcribing" | "scored" | "failed";

interface StartResponse {
  recordingId: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface RecordingRow {
  id: string;
  status: RecordingStatus;
  layout: Layout;
  filename: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  transcriptId: string | null;
  error: string | null;
  createdAt: string;
}

const LAYOUT_INFO: Record<string, { label: string; hint: string }> = {
  mono: { label: "One track (most downloads)", hint: "Speakers are told apart by voice and shown as Speaker 1 / Speaker 2, not as agent or client." },
  agent_left: { label: "Stereo, agent on the left", hint: "Each side is transcribed on its own, so agent and client are labelled correctly." },
  agent_right: { label: "Stereo, agent on the right", hint: "Each side is transcribed on its own, so agent and client are labelled correctly." },
};

const STATUS: Record<RecordingStatus, { label: string; tone: StatusTone }> = {
  uploading: { label: "Upload not finished", tone: "neutral" },
  queued: { label: "Waiting", tone: "neutral" },
  transcribing: { label: "Transcribing", tone: "info" },
  scored: { label: "Scored", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const PENDING: RecordingStatus[] = ["queued", "transcribing"];

/** Content type for the signed upload; the browser leaves some audio types blank. */
function typeFor(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm",
    opus: "audio/opus",
    aac: "audio/aac",
    amr: "audio/amr",
  };
  return byExt[ext] ?? "application/octet-stream";
}

/** PUT with progress; fetch has no upload progress. */
function putFile(url: string, file: File, headers: Record<string, string>, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function RecordingUpload({ config, onOpen }: { config: CsConfig | undefined; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [layout, setLayout] = useState<Layout>("mono");
  const [phone, setPhone] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [rubricId, setRubricId] = useState("");
  // A file already in storage whose confirmation failed: retrying only re-confirms it.
  const uploaded = useRef<{ file: File; recordingId: string } | null>(null);
  // Mirrors the ref so the button label re-renders when a retry becomes possible.
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const audio = config?.audio;
  const layouts = (audio?.layouts ?? []).map((value) => ({ value, ...(LAYOUT_INFO[value] ?? { label: value, hint: "" }) }));
  const selectedLayout = layouts.find((item) => item.value === layout) ?? layouts[0];
  const maxBytes = audio?.maxBytes ?? 500 * 1024 * 1024;
  const accept = (audio?.acceptedFormats ?? [".mp3", ".wav", ".m4a"]).join(",");

  const list = useQuery({
    queryKey: [...QK, "recordings"],
    queryFn: () => customFetch<{ recordings: RecordingRow[] }>("/api/call-scoring/recordings?limit=25"),
    enabled: Boolean(audio?.supported),
    refetchInterval: (q) => (q.state.data?.recordings.some((r) => PENDING.includes(r.status)) ? 15_000 : false),
  });

  const confirm = (recordingId: string) =>
    customFetch<{ status: RecordingStatus }>(`/api/call-scoring/recordings/${recordingId}/uploaded`, { method: "POST" });

  const send = useMutation({
    mutationFn: async (f: File) => {
      const done = uploaded.current?.file === f ? uploaded.current.recordingId : null;
      if (done) return confirm(done);
      const start = await customFetch<StartResponse>("/api/call-scoring/recordings/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: f.name.slice(0, 200),
          contentType: typeFor(f),
          sizeBytes: f.size,
          ...(selectedLayout ? { layout: selectedLayout.value } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(externalRef.trim() ? { externalRef: externalRef.trim() } : {}),
          ...(rubricId ? { rubricId } : {}),
        }),
      });
      setProgress(0);
      try {
        await putFile(start.uploadUrl, f, start.headers, setProgress);
      } catch {
        throw Object.assign(new Error("upload"), { data: { error: "The upload did not finish. Check your connection and try again." } });
      }
      uploaded.current = { file: f, recordingId: start.recordingId };
      setRetryFile(f);
      return confirm(start.recordingId);
    },
    onSuccess: () => {
      uploaded.current = null;
      setRetryFile(null);
      setFile(null);
      setProblem(null);
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Uploaded. Transcription usually takes a few minutes; the call is scored when it finishes.");
      void qc.invalidateQueries({ queryKey: [...QK, "recordings"] });
    },
    onError: (err) => setProblem(apiMessage(err, "The recording could not be uploaded.")),
    onSettled: () => setProgress(null),
  });

  if (!audio?.supported) {
    return (
      <SectionCard title="Score a recording" description="Upload a call recording and have it transcribed, then scored.">
        <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
          <FileAudio className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{audio?.message ?? "Audio transcription is not set up yet."}</span>
        </p>
      </SectionCard>
    );
  }

  const tooBig = file ? file.size > maxBytes : false;
  const hint = selectedLayout?.hint;

  return (
    <SectionCard
      title="Score a recording"
      description="Upload an ENROLLHERE download or any dialer's recording. It is transcribed with Google Speech-to-Text (covered by the Google Cloud BAA), then scored like a transcript."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file || tooBig) return;
          setProblem(null);
          send.mutate(file);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-rec-file">Recording</Label>
            <Input id="cs-rec-file" ref={fileRef} type="file" accept={`${accept},audio/*`} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">Up to {mb(maxBytes)}. MP3, WAV, M4A and most audio formats.</p>
          </div>
          {layouts.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="cs-rec-layout">Channels</Label>
              <Select value={selectedLayout?.value} onValueChange={setLayout}>
                <SelectTrigger id="cs-rec-layout">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {layouts.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            </div>
          )}
          {(config?.rubrics.length ?? 0) > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="cs-rec-rubric">Checklist</Label>
              <Select value={rubricId || config?.defaultRubricId || ""} onValueChange={setRubricId}>
                <SelectTrigger id="cs-rec-rubric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {config!.rubrics.map((rb) => (
                    <SelectItem key={rb.id} value={rb.id}>
                      {rb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="cs-rec-phone">Client phone (optional)</Label>
            <Input id="cs-rec-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="(512) 555-0100" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-rec-ref">Call reference (optional)</Label>
            <Input id="cs-rec-ref" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} maxLength={120} placeholder="ENROLLHERE call ID" />
          </div>
        </div>
        {tooBig && (
          <p role="alert" className="text-sm text-destructive">
            That file is {mb(file!.size)}; the limit is {mb(maxBytes)}. Split the call or export it at a lower bitrate.
          </p>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!file || tooBig || send.isPending}>
            {send.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />}
            {progress !== null ? `Uploading ${progress}%` : send.isPending ? "Starting…" : retryFile && retryFile === file ? "Retry" : "Upload and score"}
          </Button>
          <span className="text-xs text-muted-foreground">Recordings are kept encrypted for the 10-year CMS retention period.</span>
        </div>
      </form>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold">Recent recordings</h3>
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : list.isError ? (
          <p className="text-sm text-destructive">Recordings could not be loaded.</p>
        ) : !list.data?.recordings.length ? (
          <p className="text-sm text-muted-foreground">No recordings uploaded yet.</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm" aria-label="Recent recordings">
            {list.data.recordings.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 p-3">
                <span className="min-w-0 flex-1 truncate font-medium">{r.filename ?? "Recording"}</span>
                <span className="text-xs text-muted-foreground">{fmtDate(r.createdAt)}</span>
                <StatusPill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusPill>
                {r.status === "scored" && r.transcriptId && (
                  <Button size="sm" variant="outline" onClick={() => onOpen(r.transcriptId!)}>
                    Open call
                  </Button>
                )}
                {r.error && <span className="basis-full text-xs text-muted-foreground">{r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
