/**
 * Svix webhook signature verification (used by Resend).
 *
 * Resend signs every webhook with Svix: headers `svix-id`, `svix-timestamp`
 * and `svix-signature` ("v1,<base64>" entries, space-separated). The signed
 * content is `${id}.${timestamp}.${rawBody}` and the key is the base64 part
 * of the endpoint secret ("whsec_<base64>"). We re-implement the check here
 * rather than pull in the svix SDK — it is a dozen lines of HMAC.
 *
 * Fails closed: no secret, missing header, stale timestamp (> 5 min skew) or
 * no matching signature → false.
 */
import crypto from "crypto";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export function resendWebhookSecret(): string | null {
  const s = process.env.RESEND_WEBHOOK_SECRET?.trim();
  return s ? s : null;
}

function secretBytes(secret: string): Buffer | null {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const buf = Buffer.from(raw, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export function signSvixPayload(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): string {
  const key = secretBytes(secret) ?? Buffer.alloc(0);
  const sig = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest("base64");
  return `v1,${sig}`;
}

export function verifySvixSignature(opts: {
  secret: string | null;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, rawBody } = opts;
  if (!secret || !id || !timestamp || !signature) return false;
  const key = secretBytes(secret);
  if (!key) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SVIX_TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest();

  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    let given: Buffer;
    try {
      given = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return true;
    }
  }
  return false;
}
