/**
 * SMS client (Twilio).
 *
 * Provides a typed interface for sending outbound SMS and handling inbound
 * webhooks (see routes/webhooks.ts).
 *
 * Required environment secrets:
 *   TWILIO_ACCOUNT_SID   — Twilio Account SID
 *   TWILIO_AUTH_TOKEN    — Twilio Auth Token
 *   TWILIO_FROM_NUMBER   — E.164 format: +15551234567
 *
 * All send operations are fire-and-forget safe — never throw synchronously.
 */

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

export interface TwilioInboundWebhookPayload {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  Body: string;
  NumMedia: string;
  MediaUrl0?: string;
}

function isConfigured(): boolean {
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

    const data = await res.json() as { sid?: string; status?: string; code?: number; message?: string };

    if (!res.ok) {
      logger.error(
        { to: opts.to, status: res.status, code: data.code },
        `SMS send failed: ${data.message ?? res.statusText}`,
      );
      return { success: false, error: data.message ?? res.statusText, code: data.code };
    }

    return { sid: data.sid!, status: data.status!, success: true };
  } catch (err) {
    logger.error({ err, to: opts.to }, "SMS send exception");
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Validate that an inbound Twilio webhook originates from Twilio by checking
 * the X-Twilio-Signature header.
 *
 * NOTE: Full signature validation requires the twilio npm package's
 * validateRequest() helper. This stub does the structural check; install
 * and wire the full implementation when inbound SMS is enabled.
 */
export function validateTwilioWebhookSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  if (!process.env.TWILIO_AUTH_TOKEN) return false;
  logger.warn("Twilio webhook signature validation: full HMAC-SHA1 not implemented; install 'twilio' package");
  return Boolean(signature);
}
