/**
 * Signed, per-recipient email unsubscribe tokens (CAN-SPAM / RFC 8058).
 *
 * A token names WHO is unsubscribing — a campaign recipient row (`r`) or, for
 * drip-sequence email that has no recipient row, a contact (`c`) — and carries
 * an HMAC-SHA256 over that subject keyed by `CAMPAIGN_UNSUBSCRIBE_SECRET`.
 *
 * Why this shape:
 *  - The subject ids are random UUIDs, so tokens are not enumerable, and the
 *    HMAC means nobody can mint a token for an id they merely guessed.
 *  - The token holds no email address or name, so a forwarded link or a
 *    server log line leaks nothing about the person.
 *  - Verification is constant-time and returns `null` for every failure mode
 *    (bad format, wrong key, unknown version) — callers show one generic
 *    response so the endpoint cannot be used as an oracle.
 *
 * Secret rotation invalidates outstanding links, which is acceptable for a
 * marketing unsubscribe link (the footer also carries the agency's address
 * and reply path). Set a long random value (>= 32 chars).
 */
import crypto from "crypto";

export type UnsubscribeSubject = { kind: "r" | "c"; id: string };

const VERSION = "v1";
const MIN_SECRET_LENGTH = 32;

export function unsubscribeSecret(): string | null {
  const s = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET?.trim();
  return s && s.length >= MIN_SECRET_LENGTH ? s : null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mac(secret: string, subject: UnsubscribeSubject): Buffer {
  return crypto
    .createHmac("sha256", secret)
    .update(`${VERSION}:${subject.kind}:${subject.id}`, "utf8")
    .digest();
}

/** Returns null when the signing secret is not configured. */
export function signUnsubscribeToken(
  subject: UnsubscribeSubject,
  secret: string | null = unsubscribeSecret(),
): string | null {
  if (!secret) return null;
  const payload = b64url(Buffer.from(`${subject.kind}:${subject.id}`, "utf8"));
  return `${payload}.${b64url(mac(secret, subject))}`;
}

export function verifyUnsubscribeToken(
  token: string,
  secret: string | null = unsubscribeSecret(),
): UnsubscribeSubject | null {
  if (!secret || typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep !== 1) return null;
  const kind = decoded.slice(0, 1);
  const id = decoded.slice(2);
  if ((kind !== "r" && kind !== "c") || id.length === 0 || id.length > 128) return null;

  const subject: UnsubscribeSubject = { kind, id };
  const expected = mac(secret, subject);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? subject : null;
}

/** Public base URL the unsubscribe link points at (APP_BASE_URL). */
export function publicBaseUrl(): string | null {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export const UNSUBSCRIBE_PATH = "/api/campaigns/v1/unsubscribe";

export function unsubscribeUrl(subject: UnsubscribeSubject): string | null {
  const base = publicBaseUrl();
  const token = signUnsubscribeToken(subject);
  if (!base || !token) return null;
  return `${base}${UNSUBSCRIBE_PATH}/${token}`;
}
