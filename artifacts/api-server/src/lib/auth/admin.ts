/**
 * Identity Platform account administration (ADR 0006): the server-side calls
 * that used to go to Clerk's backend API. Uses the service's own Google
 * credentials (Cloud Run service account, which needs the "Identity Platform
 * Admin" or "Firebase Authentication Admin" role).
 */
import { GoogleAuth } from "google-auth-library";
import { identityProjectId } from "./identity";
import { logger } from "../logger";

const API = "https://identitytoolkit.googleapis.com/v1";
let auth: GoogleAuth | null = null;

type Requester = (opts: { url: string; method: "POST"; data: unknown }) => Promise<unknown>;
let requesterForTests: Requester | null = null;
export function setIdentityAdminForTests(r: Requester | null): void {
  requesterForTests = r;
}

async function call(path: string, data: unknown): Promise<void> {
  const projectId = identityProjectId();
  if (!projectId) throw new Error("IDENTITY_PLATFORM_PROJECT_ID is not set");
  const url = `${API}/projects/${encodeURIComponent(projectId)}${path}`;
  if (requesterForTests) {
    await requesterForTests({ url, method: "POST", data });
    return;
  }
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  await client.request({ url, method: "POST", data });
}

/**
 * Cancel every refresh token the identity holds, so no device can mint new ID
 * tokens without signing in again. Best effort: returns false (and logs) on
 * failure; callers also end the sessions in our own table.
 */
export async function revokeRefreshTokens(subject: string): Promise<boolean> {
  try {
    await call("/accounts:update", { localId: subject, validSince: String(Math.floor(Date.now() / 1000)) });
    return true;
  } catch (err) {
    logger.warn({ errName: (err as Error).name }, "Identity Platform: could not revoke refresh tokens");
    return false;
  }
}
