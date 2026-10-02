/**
 * Google Drive adapter: lists a watched folder (and its subfolders, two levels
 * deep, since agencies typically keep one folder per carrier) and downloads
 * files with a read-only service account.
 *
 * Credentials: `STATEMENT_INGEST_GOOGLE_CREDENTIALS` (service-account JSON, as a
 * string) or Application Default Credentials. The folder must be shared with
 * the service account's email, and the account must live in the Workspace
 * that holds the BAA.
 */
import { GoogleAuth } from "google-auth-library";
import type { SourceFile, StatementSource } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";
const MAX_DEPTH = 2;
/** Same ceiling as the manual upload route. */
export const MAX_STATEMENT_BYTES = 50 * 1024 * 1024;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

interface DriveClient {
  request<T>(opts: { url: string; params?: Record<string, string>; responseType?: "json" | "arraybuffer" }): Promise<{ data: T }>;
}

let sharedClient: Promise<DriveClient> | null = null;

function parseCredentials(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Never surface JSON.parse's message: it quotes the start of the input, which is the secret.
    throw new Error("STATEMENT_INGEST_GOOGLE_CREDENTIALS is not valid service-account JSON");
  }
}

function defaultClient(): Promise<DriveClient> {
  sharedClient ??= (async () => {
    const raw = process.env.STATEMENT_INGEST_GOOGLE_CREDENTIALS?.trim();
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      ...(raw ? { credentials: parseCredentials(raw) } : {}),
    });
    return (await auth.getClient()) as unknown as DriveClient;
  })().catch((err) => {
    // Do not cache a failure: a transient auth error must not stick until restart.
    sharedClient = null;
    throw err;
  });
  return sharedClient;
}

export class DriveStatementSource implements StatementSource {
  constructor(
    private readonly folderId: string,
    private readonly client: () => Promise<DriveClient> = defaultClient,
  ) {}

  async list(): Promise<SourceFile[]> {
    const out: SourceFile[] = [];
    await this.walk(this.folderId, null, 1, out);
    return out;
  }

  async download(file: SourceFile): Promise<Buffer> {
    const client = await this.client();
    const res = await client.request<ArrayBuffer>({
      url: `${DRIVE_API}/files/${encodeURIComponent(file.externalId)}`,
      params: { alt: "media", supportsAllDrives: "true" },
      responseType: "arraybuffer",
    });
    return Buffer.from(res.data);
  }

  private async walk(folderId: string, folderName: string | null, depth: number, out: SourceFile[]): Promise<void> {
    const client = await this.client();
    let pageToken: string | undefined;
    do {
      const res = await client.request<{ files?: DriveFile[]; nextPageToken?: string }>({
        url: `${DRIVE_API}/files`,
        params: {
          q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
          fields: "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, size)",
          pageSize: "200",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const f of res.data.files ?? []) {
        if (f.mimeType === FOLDER_MIME) {
          if (depth < MAX_DEPTH) await this.walk(f.id, f.name, depth + 1, out);
          continue;
        }
        const native = f.mimeType.startsWith(GOOGLE_NATIVE_PREFIX);
        const modified = f.modifiedTime ? new Date(f.modifiedTime) : null;
        out.push({
          externalId: f.id,
          name: f.name,
          folderName,
          // Native Google files have no md5. They can never be read as bytes anyway, so use a
          // STABLE fingerprint: one review row per file, not a new one on every edit/recalc.
          checksum: f.md5Checksum ?? "native-google-file",
          modifiedTime: modified,
          sizeBytes: f.size ? Number(f.size) : null,
          downloadable: !native,
        });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
}
