/**
 * Speech-to-text for call recordings: Google Cloud Speech-to-Text v2.
 *
 * The audio stays in the private Cloud Storage bucket; Google reads it by
 * `gs://` URI with the service's own credentials (Application Default
 * Credentials, the same ones object storage uses). Speech-to-Text is covered
 * by Google Cloud's BAA, so PHI never leaves the BAA boundary.
 *
 * Off until SPEECH_TO_TEXT_PROVIDER=google. Everything else has a default:
 *   GOOGLE_CLOUD_PROJECT  project to bill (falls back to ADC's project)
 *   SPEECH_LOCATION       regional endpoint, default "us" (data stays in the US)
 *   SPEECH_MODEL          default "chirp_3"
 *
 * Who is speaking: a stereo recording with the agent on one channel is the
 * reliable case — each channel is transcribed on its own and labelled
 * "Agent" / "Client". A mono recording is split by voice ("Speaker 1",
 * "Speaker 2"); those labels stay unknown roles, because roles are never
 * guessed from what was said (see parse.ts).
 */
import { GoogleAuth } from "google-auth-library";
import type { CallRecordingLayout } from "@workspace/db";

export interface SpeechConfig {
  projectId: string | null;
  location: string;
  model: string;
}

export interface SpeechSetup {
  ready: boolean;
  /** Names of settings that are missing or wrong. Never values. */
  missing: string[];
  message: string;
}

const LOCATION_RE = /^[a-z0-9-]+$/;
const MODEL_RE = /^[a-z0-9_.-]+$/;

export function speechConfig(env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  const location = env.SPEECH_LOCATION?.trim() || "us";
  const model = env.SPEECH_MODEL?.trim() || "chirp_3";
  return {
    projectId: env.GOOGLE_CLOUD_PROJECT?.trim() || env.GCLOUD_PROJECT?.trim() || null,
    location: LOCATION_RE.test(location) ? location : "us",
    model: MODEL_RE.test(model) ? model : "chirp_3",
  };
}

export function speechSetup(env: NodeJS.ProcessEnv = process.env): SpeechSetup {
  const missing: string[] = [];
  if (env.SPEECH_TO_TEXT_PROVIDER?.trim().toLowerCase() !== "google") missing.push("SPEECH_TO_TEXT_PROVIDER");
  if (!env.PRIVATE_OBJECT_DIR?.trim()) missing.push("PRIVATE_OBJECT_DIR");
  if (missing.length) {
    return {
      ready: false,
      missing,
      message: "Recording transcription is not set up. Upload a text transcript instead, or ask the administrator to turn on Google Speech-to-Text.",
    };
  }
  return { ready: true, missing: [], message: "Recordings are transcribed with Google Speech-to-Text (covered by the Google Cloud BAA), then scored." };
}

/** The `gs://` URI for an object path under PRIVATE_OBJECT_DIR ("/bucket/dir"). */
export function gsUri(privateObjectDir: string, objectKey: string): string {
  const dir = privateObjectDir.replace(/^\/+|\/+$/g, "");
  return `gs://${dir}/${objectKey.replace(/^\/+/, "")}`;
}

function endpoint(location: string): string {
  return location === "global" ? "https://speech.googleapis.com" : `https://${location}-speech.googleapis.com`;
}

let auth: GoogleAuth | null = null;
function client(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth;
}

/** Test seam: replaces the HTTP call to Google. */
export type SpeechHttp = (req: { url: string; method: "GET" | "POST"; data?: unknown }) => Promise<unknown>;
let httpOverride: SpeechHttp | null = null;
export function setSpeechHttpForTests(fn: SpeechHttp | null): void {
  httpOverride = fn;
}

async function call(req: { url: string; method: "GET" | "POST"; data?: unknown }): Promise<unknown> {
  if (httpOverride) return httpOverride(req);
  const c = await client().getClient();
  const res = await c.request({ url: req.url, method: req.method, data: req.data, timeout: 30_000 });
  return res.data;
}

async function projectId(cfg: SpeechConfig): Promise<string> {
  if (cfg.projectId) return cfg.projectId;
  if (httpOverride) return "test-project";
  return client().getProjectId();
}

/**
 * Word timestamps are left off: with them chirp_3 batch only takes 20 minutes
 * of audio, and Medicare sales calls run longer (about an hour without). Turn
 * times come from each result's end offset instead.
 */
export function recognitionConfig(cfg: SpeechConfig, layout: CallRecordingLayout): Record<string, unknown> {
  const features: Record<string, unknown> = {
    enableAutomaticPunctuation: true,
  };
  if (layout === "mono") features.diarizationConfig = { minSpeakerCount: 2, maxSpeakerCount: 2 };
  else features.multiChannelMode = "SEPARATE_RECOGNITION_PER_CHANNEL";
  return {
    autoDecodingConfig: {},
    model: cfg.model,
    languageCodes: ["en-US"],
    features,
  };
}

/** Start transcribing one file. Returns the long-running operation's name. */
export async function startTranscription(uri: string, layout: CallRecordingLayout, cfg = speechConfig()): Promise<string> {
  const project = await projectId(cfg);
  const recognizer = `projects/${project}/locations/${cfg.location}/recognizers/_`;
  const data = (await call({
    url: `${endpoint(cfg.location)}/v2/${recognizer}:batchRecognize`,
    method: "POST",
    data: {
      config: recognitionConfig(cfg, layout),
      files: [{ uri }],
      recognitionOutputConfig: { inlineResponseConfig: {} },
    },
  })) as { name?: unknown };
  if (typeof data?.name !== "string" || !data.name) throw new Error("Speech-to-Text did not return an operation");
  return data.name;
}

interface BatchTranscript {
  results?: SpeechResult[];
  metadata?: { totalBilledDuration?: string };
}
interface BatchFileResult {
  error?: { message?: string };
  inlineResult?: { transcript?: BatchTranscript };
  transcript?: BatchTranscript;
  metadata?: { totalBilledDuration?: string };
}

export type TranscriptionPoll =
  | { state: "running" }
  | { state: "done"; results: SpeechResult[]; durationSeconds: number | null }
  | { state: "failed"; reason: string };

export interface SpeechWord {
  word?: string;
  startOffset?: string;
  endOffset?: string;
  speakerLabel?: string;
}
export interface SpeechResult {
  alternatives?: Array<{ transcript?: string; words?: SpeechWord[] }>;
  channelTag?: number;
  resultEndOffset?: string;
}

/** Check an operation. A Google error message is reduced to a safe summary. */
export async function pollTranscription(operationName: string, cfg = speechConfig()): Promise<TranscriptionPoll> {
  if (!/^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/.test(operationName)) {
    return { state: "failed", reason: "The transcription job reference is invalid." };
  }
  const op = (await call({ url: `${endpoint(cfg.location)}/v2/${operationName}`, method: "GET" })) as {
    done?: boolean;
    error?: { message?: string };
    response?: { results?: Record<string, BatchFileResult> };
  };
  if (!op?.done) return { state: "running" };
  if (op.error) return { state: "failed", reason: safeReason(op.error.message) };
  const files = Object.values(op.response?.results ?? {});
  const file = files[0];
  if (!file) return { state: "failed", reason: "Speech-to-Text returned no result for the recording." };
  if (file.error?.message) return { state: "failed", reason: safeReason(file.error.message) };
  // Current API: inlineResult.transcript; older responses put it at `transcript`.
  const transcript = file.inlineResult?.transcript ?? file.transcript;
  const results = transcript?.results ?? [];
  const billed = file.metadata?.totalBilledDuration ?? transcript?.metadata?.totalBilledDuration;
  return { state: "done", results, durationSeconds: billed ? Math.round(seconds(billed) ?? 0) || null : null };
}

/** Ask Google to stop an operation. Best effort: false when it could not be cancelled. */
export async function cancelTranscription(operationName: string, cfg = speechConfig()): Promise<boolean> {
  if (!/^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/.test(operationName)) return false;
  try {
    await call({ url: `${endpoint(cfg.location)}/v2/${operationName}:cancel`, method: "POST", data: {} });
    return true;
  } catch {
    return false;
  }
}

/** Google's messages can name buckets and objects; keep only the kind of failure. */
export function safeReason(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("duration") || m.includes("too long") || m.includes("exceeds")) return "The recording is too long for transcription. Split the call into parts of under an hour.";
  if (m.includes("permission") || m.includes("denied")) return "Speech-to-Text could not read the recording (permission). The service account needs the Cloud Speech Client role and read access to the bucket.";
  if (m.includes("not found")) return "Speech-to-Text could not find the recording or the model in this region.";
  if (m.includes("audio") || m.includes("decod") || m.includes("encoding")) return "The audio could not be decoded. Upload MP3, WAV, FLAC, M4A, OGG or WEBM.";
  if (m.includes("diarization") || m.includes("model")) return "The speech model does not support this request. Check SPEECH_MODEL and SPEECH_LOCATION.";
  return "Speech-to-Text could not transcribe the recording.";
}

/** "12.340s" → 12.34 */
export function seconds(d: string | undefined): number | null {
  if (!d) return null;
  const n = Number.parseFloat(d.replace(/s$/, ""));
  return Number.isFinite(n) ? n : null;
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
}

/**
 * Speech results → the utterance JSON parse.ts already reads.
 *
 * Stereo: one turn per result, labelled by channel ("Agent" / "Client"). A
 * turn starts where the previous result on the same channel ended. If Google
 * returns no channel tags, nobody is labelled Agent or Client: every turn is
 * an unknown "Speaker", so no check is scored against the wrong person.
 * Mono: consecutive words with the same speaker label become one turn,
 * labelled "Speaker N" (unknown role). Without word-level speakers, each
 * result is one unlabelled turn.
 */
export function resultsToTurns(results: SpeechResult[], layout: CallRecordingLayout): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  if (layout !== "mono") {
    const agentChannel = layout === "agent_left" ? 1 : 2;
    const tagged = results.every((r) => typeof r.channelTag === "number" || !r.alternatives?.[0]?.transcript?.trim());
    const lastEnd = new Map<number | undefined, number>();
    for (const r of results) {
      const alt = r.alternatives?.[0];
      const text = alt?.transcript?.trim();
      const end = seconds(r.resultEndOffset) ?? undefined;
      const start = lastEnd.get(r.channelTag) ?? 0;
      if (end !== undefined) lastEnd.set(r.channelTag, end);
      if (!text) continue;
      const speaker = !tagged ? "Speaker" : r.channelTag === agentChannel ? "Agent" : "Client";
      turns.push({ speaker, text, start: end !== undefined ? start : undefined, end });
    }
    return turns.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0));
  }

  let prevEnd = 0;
  for (const r of results) {
    const alt = r.alternatives?.[0];
    const words = (alt?.words ?? []).filter((w) => w.word?.trim());
    const resultEnd = seconds(r.resultEndOffset) ?? undefined;
    const resultStart = prevEnd;
    if (resultEnd !== undefined) prevEnd = resultEnd;
    if (!words.length || !words.some((w) => w.speakerLabel)) {
      const text = alt?.transcript?.trim();
      if (text) turns.push({ speaker: "Speaker", text, start: seconds(words[0]?.startOffset) ?? (resultEnd !== undefined ? resultStart : undefined), end: resultEnd });
      continue;
    }
    for (const w of words) {
      const speaker = w.speakerLabel ? `Speaker ${w.speakerLabel}` : "Speaker";
      const last = turns[turns.length - 1];
      const start = seconds(w.startOffset) ?? undefined;
      const end = seconds(w.endOffset) ?? undefined;
      if (last && last.speaker === speaker) {
        last.text += ` ${w.word!.trim()}`;
        if (end !== undefined) last.end = end;
      } else {
        turns.push({ speaker, text: w.word!.trim(), start, end });
      }
    }
  }
  return turns;
}
