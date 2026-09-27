/**
 * Email unsubscribe links for consumer outreach (CAN-SPAM, 15 U.S.C. 7704).
 *
 * Every automated email to a contact carries a working opt-out: a footer link
 * plus RFC 2369 / RFC 8058 `List-Unsubscribe` headers so mail clients show a
 * native one-click unsubscribe. The link embeds a signed token naming the
 * contact, so the public endpoint can honour it without a login and without
 * letting anyone unsubscribe arbitrary contacts.
 *
 * Token: base64url(JSON {v, o, c}) "." base64url(HMAC-SHA256(key, payload)).
 * The key is derived from PHI_HMAC_KEY (already required in production) with a
 * purpose label, so it is never reused verbatim for another purpose.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "agencybridge:email-unsubscribe:v1";
const DEV_KEY_MATERIAL = "agencybridge-dev-unsubscribe-key-not-for-production";

export const UNSUBSCRIBE_PATH = "/api/public/unsubscribe";

function isNonProdEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development" || env === undefined;
}

function signingKey(): Buffer {
  const raw = process.env.PHI_HMAC_KEY;
  if (!raw) {
    if (isNonProdEnv()) return createHmac("sha256", DEV_KEY_MATERIAL).update(PURPOSE).digest();
    throw new Error("PHI_HMAC_KEY is required to sign unsubscribe links in production");
  }
  return createHmac("sha256", Buffer.from(raw, "base64")).update(PURPOSE).digest();
}

export interface UnsubscribeClaims {
  orgId: string;
  contactId: string;
}

export function signUnsubscribeToken(claims: UnsubscribeClaims): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, o: claims.orgId, c: claims.contactId })).toString("base64url");
  const mac = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribeClaims | null {
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", signingKey()).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: number; o?: unknown; c?: unknown };
    if (parsed.v !== 1 || typeof parsed.o !== "string" || typeof parsed.c !== "string") return null;
    return { orgId: parsed.o, contactId: parsed.c };
  } catch {
    return null;
  }
}

/** Public base URL for links in outbound mail, or null when not configured. */
export function publicBaseUrl(): string | null {
  const configured = (process.env.APP_BASE_URL ?? process.env.APP_PUBLIC_URL)?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return isNonProdEnv() ? "http://localhost:5173" : null;
}

/**
 * The unsubscribe link for a contact, or null when this deployment cannot
 * build one (no public base URL, or no signing key). Never throws: callers
 * treat null as "cannot send commercial email".
 */
export function unsubscribeUrl(claims: UnsubscribeClaims): string | null {
  const base = publicBaseUrl();
  if (!base) return null;
  let token: string;
  try {
    token = signUnsubscribeToken(claims);
  } catch {
    return null;
  }
  return `${base}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
}

/**
 * Configuration problems that stop automated consumer email, reported at boot
 * (index.ts) at ERROR so a misconfigured deploy is loud. Not a boot failure:
 * the rest of the CRM keeps working; only automated consumer email is held,
 * because it cannot legally go out without a working opt-out link.
 */
export function consumerEmailConfigIssues(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const issues: string[] = [];
  if (!env.PHI_HMAC_KEY) issues.push("PHI_HMAC_KEY is not set: unsubscribe links cannot be signed");
  if (!(env.APP_BASE_URL ?? env.APP_PUBLIC_URL)?.trim()) {
    issues.push("APP_BASE_URL (or APP_PUBLIC_URL) is not set: unsubscribe links cannot be built");
  }
  return issues;
}

/** Footer appended to every automated consumer email. */
export function unsubscribeFooterHtml(url: string): string {
  return (
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">` +
    `<p style="font-size:12px;color:#64748b;margin:0">You are receiving this email about your Medicare coverage options. ` +
    `<a href="${url}" style="color:#64748b">Unsubscribe</a> to stop receiving these emails.</p>`
  );
}

/** RFC 2369 + RFC 8058 headers for one-click unsubscribe in mail clients. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
