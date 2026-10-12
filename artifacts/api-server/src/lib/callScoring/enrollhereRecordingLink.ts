/**
 * EnrollHere recording links (the "Recording URL" column of a call-log
 * export) and the download that moves the audio into our private bucket.
 *
 * The link is a signed Google Cloud Storage URL on EnrollHere's own bucket
 * (`storage.googleapis.com/enroll-here-dialer-…`). It opens without an
 * EnrollHere login and expires a few days after the export, so it is fetched
 * as soon as the call log is imported. Only that host and bucket family are
 * accepted (no redirects), so an edited CSV cannot make the server fetch an
 * arbitrary or internal address. The link is a credential: it is kept sealed
 * on the recording row until the audio is stored, and never logged.
 */
import { Readable } from "node:stream";

const HOST = "storage.googleapis.com";
const BUCKET_PATH_RE = /^\/enroll-here-dialer-[a-z0-9-]+\/./;

/** Same ceiling as a browser upload (routes/callScoring.ts MAX_RECORDING_BYTES). */
export const MAX_FETCH_BYTES = 500 * 1024 * 1024;
/**
 * Must stay under the recordings sweep's STALLED_AFTER_MS (10 min): the
 * fetching step marks the row only when it starts, so a download still
 * running at that age would be picked up and started a second time.
 */
export const FETCH_TIMEOUT_MS = 8 * 60 * 1000;

/** A link that will never work (expired, refused, too large, empty): do not retry. */
export class RecordingLinkError extends Error {}

/** The parsed link when it points at EnrollHere's recording storage; otherwise null. */
export function enrollhereRecordingUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== HOST || u.port || u.username || u.password) return null;
  return BUCKET_PATH_RE.test(u.pathname) ? u : null;
}

export interface RecordingWriter {
  saveCallRecording(objectKey: string, body: Readable, contentType: string): Promise<void>;
}

type FetchLike = (url: URL, init: { redirect: "error"; signal: AbortSignal }) => Promise<Response>;

/** Download the recording into `objectKey`; returns its size in bytes. */
export async function downloadRecording(url: URL, objectKey: string, store: RecordingWriter, fetchImpl: FetchLike = fetch): Promise<number> {
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if ([400, 401, 403, 404, 410].includes(res.status)) {
    throw new RecordingLinkError("EnrollHere refused the recording link (it has probably expired). Import a fresh call-log export to try again.");
  }
  if (!res.ok || !res.body) throw new Error(`recording download failed with HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) throw new RecordingLinkError("The recording is larger than the 500 MB limit.");
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const contentType = type.startsWith("audio/") ? type : "audio/mpeg";

  let bytes = 0;
  const source = res.body;
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_FETCH_BYTES) throw new RecordingLinkError("The recording is larger than the 500 MB limit.");
      yield chunk;
    }
  }
  await store.saveCallRecording(objectKey, Readable.from(counted()), contentType);
  if (bytes === 0) throw new RecordingLinkError("EnrollHere returned an empty recording.");
  return bytes;
}
