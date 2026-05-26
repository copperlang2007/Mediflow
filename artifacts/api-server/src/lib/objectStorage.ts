import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  ObjectAccessGroupType,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

// Storage backend selector.
//
//   STORAGE_MODE=replit (default) → use the Replit Object Storage sidecar
//     at 127.0.0.1:1106. Convenient for sandbox/dev iteration on Replit.
//   STORAGE_MODE=gcs              → talk to Google Cloud Storage directly
//     via Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS,
//     workload identity, or `gcloud auth application-default login`). This
//     is the production path — there is no BAA on the Replit sidecar, so
//     real PHI must not flow through it.
//
// In production (`NODE_ENV === "production"`) `assertStorageBackendHipaaCompliant`
// hard-fails at boot unless STORAGE_MODE === "gcs". Mirrors the AI provider
// guard in `lib/aiProvider.ts`.
const STORAGE_MODE = (process.env.STORAGE_MODE ?? "replit").toLowerCase();
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

/**
 * Boot-time assertion. Call once at app/worker bootstrap so a
 * misconfigured production deploy fails fast — before any upload, download,
 * or signed-URL operation can route PHI through the Replit sidecar (which
 * has no HIPAA BAA). Allowed in non-production so local dev keeps working.
 */
export function assertStorageBackendHipaaCompliant(): void {
  if (process.env.NODE_ENV === "production" && STORAGE_MODE !== "gcs") {
    throw new Error(
      "FATAL: STORAGE_MODE must be 'gcs' in production — the Replit Object " +
        "Storage sidecar has no HIPAA BAA and must not receive PHI. " +
        `Got: ${process.env.STORAGE_MODE ?? "<unset>"}`,
    );
  }
}

export const objectStorageClient =
  STORAGE_MODE === "gcs"
    ? new Storage()
    : new Storage({
        credentials: {
          audience: "replit",
          subject_token_type: "access_token",
          token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
          type: "external_account",
          credential_source: {
            url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
            format: {
              type: "json",
              subject_token_field_name: "access_token",
            },
          },
          universe_domain: "googleapis.com",
        },
        projectId: "",
      });

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

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
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
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
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
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
  if (STORAGE_MODE === "gcs") {
    const [url] = await objectStorageClient
      .bucket(bucketName)
      .file(objectName)
      .getSignedUrl({
        version: "v4",
        action:
          method === "GET"
            ? "read"
            : method === "PUT"
              ? "write"
              : method === "DELETE"
                ? "delete"
                : "resumable",
        expires: Date.now() + ttlSec * 1000,
      });
    return url;
  }

  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const body = await response.json() as { signed_url: string };
  return body.signed_url;
}
