/**
 * masterBRIDGE webhook signature verification (spec §4.2).
 *
 * Every dialer → MediFlow webhook carries:
 *
 *     X-MB-Signature: t=<unixSeconds>,v1=<hex-hmac>
 *
 * where the HMAC is HMAC-SHA256 over the string `${t}.${rawBody}` keyed with
 * a per-tenant shared secret. The timestamp is bound to ±5 min to defeat
 * replay. This deliberately mirrors MediFlow's existing Twilio signature
 * handling (constant-time compare, fail-closed when unconfigured) — see
 * `lib/sms.ts#validateTwilioWebhookSignature`.
 *
 * The shared secret is per-tenant. For Phase 2 we resolve it from the
 * environment (`DIALER_WEBHOOK_SECRET`, optionally suffixed per org as
 * `DIALER_WEBHOOK_SECRET_<ORGID>`); Phase 4 wires it to a per-tenant secret
 * store. See `resolveWebhookSecret`.
 */
import crypto from "crypto";
import { logger } from "../logger";

/** Default replay window: ±5 minutes, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface ParsedSignature {
  t: number;
  v1: string;
}

/**
 * Parse the `t=<unixSeconds>,v1=<hex>` header. Tolerates extra/unknown
 * scheme parts (forward-compat) and arbitrary ordering. Returns null when
 * the required parts are missing or malformed.
 */
export function parseSignatureHeader(
  header: string | undefined | null,
): ParsedSignature | null {
  if (!header) return null;
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === "v1") {
      v1 = value;
    }
    // Unknown scheme parts are ignored (forward-compat).
  }
  if (t === undefined || !v1) return null;
  return { t, v1 };
}

/** Compute the expected hex HMAC-SHA256 over `${t}.${rawBody}`. */
export function computeSignature(
  secret: string,
  t: number,
  rawBody: string | Buffer,
): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  return crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`, "utf8")
    .digest("hex");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" | "unconfigured" };

/**
 * Verify an `X-MB-Signature` against the raw request body.
 *
 * Fail-closed: a missing secret yields `unconfigured` (rejected), matching
 * the Twilio handler's posture of refusing rather than silently accepting.
 */
export function verifyWebhookSignature(args: {
  secret: string | undefined;
  header: string | undefined | null;
  rawBody: string | Buffer;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): VerifyResult {
  const {
    secret,
    header,
    rawBody,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = args;

  if (!secret) {
    logger.error("Dialer webhook: shared secret not configured — rejecting");
    return { ok: false, reason: "unconfigured" };
  }

  const parsed = parseSignatureHeader(header);
  if (!header) return { ok: false, reason: "missing" };
  if (!parsed) return { ok: false, reason: "malformed" };

  // Timestamp binding (±tolerance) — replay protection.
  if (Math.abs(nowSeconds - parsed.t) > toleranceSeconds) {
    return { ok: false, reason: "stale" };
  }

  const expected = computeSignature(secret, parsed.t, rawBody);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(parsed.v1, "utf8");
    if (a.length !== b.length) return { ok: false, reason: "mismatch" };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  } catch {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/**
 * Resolve the per-tenant webhook shared secret.
 *
 * Phase 2: env-based. A per-org override `DIALER_WEBHOOK_SECRET_<ORGID>`
 * (org id upper-cased, non-alphanumerics → `_`) takes precedence over the
 * shared default `DIALER_WEBHOOK_SECRET`.
 *
 * TODO(Phase 4): resolve from MediFlow's per-tenant secret store instead of
 * the environment.
 */
export function resolveWebhookSecret(orgId?: string): string | undefined {
  if (orgId) {
    const key = `DIALER_WEBHOOK_SECRET_${orgId
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")}`;
    const perTenant = process.env[key]?.trim();
    if (perTenant) return perTenant;
  }
  return process.env.DIALER_WEBHOOK_SECRET?.trim() || undefined;
}
