/**
 * Twilio webhook trust for the Voice endpoints.
 *
 * Reuses the SMS webhook's signature validator (lib/sms.ts
 * `validateTwilioWebhookSignature`, HMAC-SHA1 over URL + sorted params with
 * TWILIO_AUTH_TOKEN, constant-time compare) and its host pinning: the URL that
 * was signed is rebuilt from the operator-configured TWILIO_WEBHOOK_PUBLIC_HOST
 * when set, never from attacker-controllable Host / X-Forwarded-* headers.
 * Without that env var it falls back to the headers so local tunnels still work.
 */
import type { Request } from "express";
import { validateTwilioWebhookSignature } from "../sms";

/** The public URL Twilio signed for this request. */
export function twilioCanonicalUrl(req: Request): string {
  const publicHost = process.env.TWILIO_WEBHOOK_PUBLIC_HOST?.trim();
  if (publicHost) return `${publicHost.replace(/\/+$/, "")}${req.originalUrl}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (req.headers["host"] as string | undefined) ?? "";
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Form params as strings, or null when any value is not a plain string
 * (a repeated key or a nested `a[b]=c` key parses to an array/object, which
 * Twilio never sends — treat it as tampering).
 */
export function twilioFormParams(req: Request): Record<string, string> | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

/** Verified form params, or null when the signature is missing/invalid. */
export function verifiedTwilioParams(req: Request): Record<string, string> | null {
  const params = twilioFormParams(req);
  if (!params) return null;
  const rawSig = req.headers["x-twilio-signature"];
  const signature = Array.isArray(rawSig) ? (rawSig[0] ?? "") : (rawSig ?? "");
  return validateTwilioWebhookSignature(twilioCanonicalUrl(req), params, signature) ? params : null;
}
