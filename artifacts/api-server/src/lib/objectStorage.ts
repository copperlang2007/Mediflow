import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  ObjectAccessGroupType,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

// Storage backend: Google Cloud Storage, the BAA-covered path for PHI.
//
// Credentials come from Application Default Credentials
// (GOOGLE_APPLICATION_CREDENTIALS, workload identity, or
// `gcloud auth application-default login`).

/**
 * The single source of truth for the `PRIVATE_OBJECT_DIR` requirement.
 * `PRIVATE_OBJECT_DIR` is the GCS location for private, PHI-bearing
 * documents; every upload/download resolves through it. Returns the trimmed
 * value, or throws a consistent error when it is unset/blank. Used by both
 * the boot guard and the runtime getter so the rule and its message stay in
 * one place.
 */
function requirePrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR must be set — it is the GCS location for private, " +
        "PHI-bearing documents. Provision a GCS bucket and set the " +
        "PRIVATE_OBJECT_DIR env var.",
    );
  }
  return dir;
}

/**
 * Boot-time storage sanity guard, invoked once at app/worker bootstrap.
 *
 * GCS is the only supported backend and is BAA-covered, so there is no
 * non-BAA backend to reject. What this DOES enforce, in production, is that
 * the private document bucket is actually configured: a prod deploy that
 * forgot to set `PRIVATE_OBJECT_DIR` would otherwise fail only on the first
 * document operation. Fail fast and visibly at boot instead. Mirrors the AI
 * provider guard in `lib/aiProvider.ts`.
 *
 * Lenient in non-production so local dev / tests that never touch storage
 * keep working without the env var.
 */
export function assertStorageBackendHipaaCompliant(): void {
  if (process.env.NODE_ENV !== "production") return;
  requirePrivateObjectDir();
}

export const objectStorageClient = new Storage();

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/** Signed into recording upload URLs: the PUT may only create the object, never replace it. */
export const CALL_RECORDING_CREATE_ONLY_HEADER = "x-goog-if-generation-match";

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Provision a GCS bucket and set " +
          "the PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    return requirePrivateObjectDir();
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Provision a GCS bucket and set the " +
          "PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    // Normalize to a leading slash so the prefix match against the GCS URL
    // pathname (always "/bucket/...") is robust even when PRIVATE_OBJECT_DIR
    // is configured without one (e.g. "my-bucket/private").
    if (!objectEntityDir.startsWith("/")) {
      objectEntityDir = `/${objectEntityDir}`;
    }
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Upload raw content (Buffer or string) to private document storage.
   *
   * Returns a normalized `/objects/...` path suitable for passing back to
   * `getDocumentSignedUrl` or `deleteDocument`.
   */
  async uploadDocument(
    content: Buffer | string,
    filename: string,
    orgId: string,
    options?: {
      contentType?: string;
      aclRules?: Array<{
        group: { type: ObjectAccessGroupType; id: string };
        permission: ObjectPermission;
      }>;
    },
  ): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const docId = randomUUID();
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fullPath = `${privateObjectDir}/documents/${orgId}/${docId}/${sanitized}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    const buffer =
      typeof content === "string" ? Buffer.from(content, "utf-8") : content;

    await file.save(buffer, {
      contentType: options?.contentType ?? "application/octet-stream",
      resumable: false,
    });

    await setObjectAclPolicy(file, {
      owner: orgId,
      visibility: "private",
      aclRules: options?.aclRules ?? [
        {
          group: { type: ObjectAccessGroupType.ORG_MEMBER, id: orgId },
          permission: ObjectPermission.READ,
        },
      ],
    });

    return `/objects/documents/${orgId}/${docId}/${sanitized}`;
  }

  /**
   * Return a presigned GET URL for a previously uploaded document.
   *
   * @param objectPath — normalized `/objects/...` path returned by `uploadDocument`
   * @param ttlSec     — URL validity window in seconds (default: 1 hour)
   */
  async getDocumentSignedUrl(
    objectPath: string,
    ttlSec = 3600,
  ): Promise<string> {
    const file = await this.getObjectEntityFile(objectPath);
    return signObjectURL({
      bucketName: file.bucket.name,
      objectName: file.name,
      method: "GET",
      ttlSec,
    });
  }

  /**
   * Call recordings live at `PRIVATE_OBJECT_DIR/call-recordings/{orgId}/{id}`.
   * The key is always built here from the org and the recording id, never
   * taken from a client, so one agency can never point at another's audio.
   */
  callRecordingKey(orgId: string, recordingId: string): string {
    return `call-recordings/${orgId}/${recordingId}`;
  }

  /**
   * A short-lived signed URL the browser PUTs the recording to directly. The
   * content type is part of the signature, so the upload must send exactly it.
   * It is create-only (`x-goog-if-generation-match: 0` is signed in), so once
   * the object exists the URL cannot overwrite it after it was validated.
   */
  async getCallRecordingUploadURL(objectKey: string, contentType: string, ttlSec = 900): Promise<string> {
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${objectKey}`);
    const [url] = await objectStorageClient
      .bucket(bucketName)
      .file(objectName)
      .getSignedUrl({
        version: "v4",
        action: "write",
        contentType,
        extensionHeaders: { [CALL_RECORDING_CREATE_ONLY_HEADER]: "0" },
        expires: Date.now() + ttlSec * 1000,
      });
    return url;
  }

  /**
   * A short-lived signed URL a browser can stream a stored recording from. The
   * object key is always built on the server (callRecordingKey), never taken
   * from a client; the caller must already have checked the person may listen.
   */
  async getCallRecordingReadURL(objectKey: string, ttlSec = 600): Promise<string> {
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${objectKey}`);
    return signObjectURL({ bucketName, objectName, method: "GET", ttlSec });
  }

  /**
   * Write a recording the server downloaded itself (EnrollHere call-log
   * import). Create-only like the signed upload URL: an object already at
   * this key is never overwritten (the caller checks for it first).
   */
  async saveCallRecording(objectKey: string, body: Readable, contentType: string): Promise<void> {
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${objectKey}`);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    await pipeline(body, file.createWriteStream({ resumable: false, contentType, preconditionOpts: { ifGenerationMatch: 0 } }));
  }

  /** Remove an uploaded recording (rejected uploads). Missing objects are fine. */
  async deleteCallRecording(objectKey: string): Promise<void> {
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${objectKey}`);
    await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  }

  /** Size and type of an uploaded recording, or null when nothing was uploaded. */
  async getCallRecordingMetadata(objectKey: string): Promise<{ size: number; contentType: string | null } | null> {
    const { bucketName, objectName } = parseObjectPath(`${this.getPrivateObjectDir()}/${objectKey}`);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    return { size: Number(meta.size ?? 0), contentType: typeof meta.contentType === "string" ? meta.contentType : null };
  }

  /**
   * Permanently delete a document from object storage.
   *
   * @param objectPath — normalized `/objects/...` path returned by `uploadDocument`
   */
  async deleteDocument(objectPath: string): Promise<void> {
    const file = await this.getObjectEntityFile(objectPath);
    await file.delete();
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const [url] = await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .getSignedUrl({
      version: "v4",
      action:
        method === "GET" || method === "HEAD"
          ? "read"
          : method === "PUT"
            ? "write"
            : "delete",
      expires: Date.now() + ttlSec * 1000,
    });
  return url;
}
