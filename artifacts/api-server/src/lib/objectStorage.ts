import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Object storage wrapper around an S3-compatible backend (AWS S3 in
 * production, MinIO in local development).
 *
 * Buckets:
 *  - private (default): requires auth + ACL check before download
 *
 * All PHI-adjacent documents (agent docs, beneficiary files) live in the
 * private bucket and are served via short-lived signed download tokens
 * minted by the storage route (see routes/storage.ts).
 *
 * Configuration (env):
 *  - S3_BUCKET            (required) target bucket name
 *  - S3_REGION            (default "us-east-1")
 *  - S3_ENDPOINT          (optional) custom endpoint, e.g. MinIO; when set,
 *                         path-style addressing is enabled
 *  - S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (optional) explicit creds;
 *                         falls back to the default AWS credential chain
 *                         (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, IAM role)
 */

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  const region = process.env.S3_REGION ?? "us-east-1";
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  _client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
  return _client;
}

function getBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "S3_BUCKET must be set. Did you forget to provision object storage?",
    );
  }
  return bucket;
}

/** Test-only: reset the memoized client (e.g. after changing env). */
export function _resetStorageClient(): void {
  _client = null;
}

export interface UploadResult {
  key: string;
  size: number;
}

export async function uploadObject(
  key: string,
  data: Buffer | Uint8Array | string,
  contentType?: string,
): Promise<UploadResult> {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: buf,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );
  return { key, size: buf.byteLength };
}

export async function downloadObject(key: string): Promise<Buffer> {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
  );
  if (!res.Body) {
    throw new Error(`Object storage download failed: empty body for ${key}`);
  }
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
  );
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await getClient().send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: key }),
    );
    return true;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Generate a deterministic storage key for an entity's document.
 * Format: <orgId>/<entityType>/<entityId>/<uuid>-<filename>
 */
export function buildObjectKey(
  orgId: string,
  entityType: string,
  entityId: string,
  filename: string,
): string {
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${orgId}/${entityType}/${entityId}/${randomUUID()}-${safe}`;
}
