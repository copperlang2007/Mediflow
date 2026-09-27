import crypto from "crypto";
import { logger } from "./logger";
import { isPhoneOptedOut } from "./compliance/consumerOutreach";

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

export async function sendSMS(
  to: string,
  body: string,
  agentId: string,
): Promise<SmsResult | SmsError> {
  // Format-independent match: a contact stored as "(512) 555-0100" must
  // still hit the opt-out Twilio recorded as "+15125550100".
  if (await isPhoneOptedOut(to)) {
    logger.warn({ to, agentId }, "SMS blocked: recipient has opted out");
    return { success: false, error: "Recipient has opted out of SMS" };
  }

  const result = await sendSms({ to, body });
  if (result.success) {
    logger.info({ to, agentId, sid: result.sid }, "SMS sent");
  }
  return result;
}

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
