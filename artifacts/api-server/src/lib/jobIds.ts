import { createHash } from "node:crypto";

/**
 * UUID derived from a job id, used as the id of that job's deferred
 * re-enqueue: if the handler is retried after the deferral was already
 * enqueued, the second insert collides on the id and is dropped, so the
 * deferral is idempotent. Shaped as an RFC 4122 version-5-style UUID
 * because pg-boss job ids are uuid columns.
 */
export function deferredJobId(jobId: string): string {
  const h = createHash("sha256").update(`deferred:${jobId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
