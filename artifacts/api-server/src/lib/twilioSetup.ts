/**
 * Twilio setup checklist for the System Health page.
 *
 * Reports, for texting and for browser calling, which environment settings are
 * in place and well-formed, plus the webhook addresses to paste into Twilio.
 * Only setting NAMES and a pass/fail with a plain reason are ever returned —
 * never a value, and never a fragment of one.
 */
import { VOICE_ENV_NAMES } from "./voice/voiceToken";

const E164 = /^\+[1-9]\d{6,14}$/;

export interface SetupCheck {
  name: string;
  ok: boolean;
  /** Why it fails, in plain words. Absent when ok. */
  problem?: string;
}

export interface TwilioSetupStatus {
  sms: { ready: boolean; checks: SetupCheck[] };
  voice: { ready: boolean; checks: SetupCheck[] };
  /** Where Twilio must send events; null until the public address is set. */
  webhooks: { smsInbound: string; voiceRequest: string; voiceStatus: string } | null;
}

type Rule = (v: string) => string | null;

const RULES: Record<string, Rule> = {
  TWILIO_ACCOUNT_SID: (v) => (/^AC[0-9a-f]{32}$/i.test(v) ? null : "should start with AC and be 34 characters"),
  TWILIO_AUTH_TOKEN: () => null,
  TWILIO_FROM_NUMBER: (v) => (E164.test(v) ? null : "should be a full number like +15125550100"),
  TWILIO_VOICE_CALLER_ID: (v) => (E164.test(v) ? null : "should be a full number like +15125550100"),
  TWILIO_API_KEY_SID: (v) => (/^SK[0-9a-f]{32}$/i.test(v) ? null : "should start with SK and be 34 characters"),
  TWILIO_API_KEY_SECRET: () => null,
  TWILIO_TWIML_APP_SID: (v) => (/^AP[0-9a-f]{32}$/i.test(v) ? null : "should start with AP and be 34 characters"),
  TWILIO_WEBHOOK_PUBLIC_HOST: (v) => (publicOrigin(v) ? null : "should be the app's address, like https://app.example.com, with no path"),
};

/** The https origin a webhook host setting names, or null when it isn't one. */
function publicOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function check(name: string, env: NodeJS.ProcessEnv): SetupCheck {
  const value = env[name]?.trim();
  if (!value) return { name, ok: false, problem: "not set" };
  const problem = (RULES[name] ?? (() => null))(value);
  return problem ? { name, ok: false, problem } : { name, ok: true };
}

const SMS_NAMES = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_WEBHOOK_PUBLIC_HOST"] as const;
const VOICE_NAMES = [...VOICE_ENV_NAMES, "TWILIO_WEBHOOK_PUBLIC_HOST"] as const;

export function twilioSetupStatus(env: NodeJS.ProcessEnv = process.env): TwilioSetupStatus {
  const sms = SMS_NAMES.map((n) => check(n, env));
  const voice = VOICE_NAMES.map((n) => check(n, env));
  const origin = env.TWILIO_WEBHOOK_PUBLIC_HOST ? publicOrigin(env.TWILIO_WEBHOOK_PUBLIC_HOST) : null;
  return {
    sms: { ready: sms.every((c) => c.ok), checks: sms },
    voice: { ready: voice.every((c) => c.ok), checks: voice },
    webhooks: origin
      ? {
          // The SMS webhook router is mounted at the app root (app.ts), not under /api.
          smsInbound: `${origin}/webhooks/twilio/sms`,
          voiceRequest: `${origin}/api/webhooks/twilio/voice`,
          voiceStatus: `${origin}/api/webhooks/twilio/voice-status`,
        }
      : null,
  };
}
