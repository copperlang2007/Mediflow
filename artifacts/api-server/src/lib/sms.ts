/**
 * SMS client (Twilio).
 *
 * Provides a typed interface for sending outbound SMS and validating inbound
 * webhooks. Twilio webhook signature validation is implemented directly using
 * Node's built-in crypto — no twilio npm package required.
 *
 * Required environment secrets:
 *   TWILIO_ACCOUNT_SID   — Twilio Account SID
 *   TWILIO_AUTH_TOKEN    — Twilio Auth Token
 *   TWILIO_FROM_NUMBER   — E.164 format: +15551234567
 *
 * All send operations never throw synchronously.
 */

import crypto from "crypto";
import { logger } from "./logger";

export interface SendSmsOptions {
  to: string;
  body: string;
  from?: string;
  mediaUrl?: string[];
}

export interface SmsResult {
  sid: string;
  status: string;
  success: true;
}

export interface SmsError {
  success: false;
  error: string;
  code?: number;
}

export interface TwilioInboundPayload {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  Body: string;
  NumMedia: string;
  MediaUrl0?: string;
  [key: string]: string | undefined;
}

export type SmsOptOutKeyword = "STOP" | "STOPALL" | "UNSUBSCRIBE" | "CANCEL" | "END" | "QUIT";

export const OPT_OUT_KEYWORDS: SmsOptOutKeyword[] = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
];

export const OPT_IN_KEYWORDS = ["START", "UNSTOP", "YES"];
export const HELP_KEYWORDS = ["HELP", "INFO"];

export function isConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER,
  );
}

function basicAuth(): string {
  const creds = `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

/**
 * Send an outbound SMS via Twilio Messages API.
 * Returns a result object — never throws.
 */
export async function sendSms(
  opts: SendSmsOptions,
): Promise<SmsResult | SmsError> {
  if (!isConfigured()) {
    logger.warn("Twilio not configured — SMS not sent");
    return { success: false, error: "SMS not configured" };
  }

  const fromNumber = opts.from ?? process.env.TWILIO_FROM_NUMBER!;
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;

  const body = new URLSearchParams({
    To: opts.to,
    From: fromNumber,
    Body: opts.body,
  });
  if (opts.mediaUrl) {
    opts.mediaUrl.forEach((url) => body.append("MediaUrl", url));
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(),
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );

    const data = await res.json() as {
      sid?: string;
      status?: string;
      code?: number;
      message?: string;
    };

    if (!res.ok) {
      logger.error(
        { to: opts.to, status: res.status, code: data.code },
        `SMS send failed: ${data.message ?? res.statusText}`,
      );
      return {
        success: false,
        error: data.message ?? res.statusText,
        code: data.code,
      };
    }

    return { sid: data.sid!, status: data.status!, success: true };
  } catch (err) {
    logger.error({ err, to: opts.to }, "SMS send exception");
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Validate that an inbound Twilio webhook originates from Twilio.
 *
 * Algorithm (per Twilio docs):
 * 1. Take the full URL of the request.
 * 2. Sort POST params alphabetically and append key+value pairs to the URL.
 * 3. Compute HMAC-SHA1 of the string using the Auth Token as key.
 * 4. Base64-encode and compare using timing-safe equality.
 *
 * Returns false if the Auth Token is not configured (requests dropped).
 */
export function validateTwilioWebhookSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.error("TWILIO_AUTH_TOKEN not set — cannot validate webhook signature");
    return false;
  }

  if (!signature) {
    logger.warn("Twilio webhook: missing X-Twilio-Signature header");
    return false;
  }

  // Build string: URL + sorted param key-value pairs (no delimiters)
  const sortedKeys = Object.keys(params).sort();
  let str = url;
  for (const key of sortedKeys) {
    str += key + (params[key] ?? "");
  }

  // HMAC-SHA1 → base64
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(str, "utf8")
    .digest("base64");

  // Constant-time comparison to prevent timing attacks
  try {
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

/**
 * Parse an inbound Twilio message body and classify the keyword intent.
 */
export function classifyInboundMessage(body: string): {
  isOptOut: boolean;
  isOptIn: boolean;
  isHelp: boolean;
  normalised: string;
} {
  const normalised = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return {
    isOptOut: (OPT_OUT_KEYWORDS as string[]).includes(normalised),
    isOptIn: OPT_IN_KEYWORDS.includes(normalised),
    isHelp: HELP_KEYWORDS.includes(normalised),
    normalised,
  };
}
