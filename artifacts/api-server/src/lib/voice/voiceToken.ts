/**
 * Twilio Voice access tokens for the browser softphone.
 *
 * Twilio access tokens are plain HS256 JWTs signed with an API Key SECRET (not
 * the account auth token), so node's crypto is enough — the heavy `twilio`
 * package is not needed. The token carries a VoiceGrant that lets the browser
 * place calls ONLY through our TwiML App (its Voice URL is the webhook that
 * dials the stored, server-derived number). It grants no incoming calls.
 *
 * Secrets are never logged and never returned; only env var NAMES are ever
 * reported (as `missing`).
 */
import { createHmac } from "node:crypto";

export const VOICE_ENV_NAMES = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_VOICE_CALLER_ID",
  // Not used to mint the token, but every voice webhook verifies Twilio's
  // signature with it — without it no call could ever connect or be logged.
  "TWILIO_AUTH_TOKEN",
] as const;
export type VoiceEnvName = (typeof VOICE_ENV_NAMES)[number];

/** Token lifetime. Twilio allows up to 24h; we keep it to the 10 minute ceiling. */
export const VOICE_TOKEN_TTL_SECONDS = 600;

const E164 = /^\+[1-9]\d{6,14}$/;

/** Names of required env vars that are unset, blank, or (caller id) not E.164. */
export function missingVoiceEnv(env: NodeJS.ProcessEnv = process.env): VoiceEnvName[] {
  return VOICE_ENV_NAMES.filter((name) => {
    const v = env[name]?.trim();
    if (!v) return true;
    if (name === "TWILIO_VOICE_CALLER_ID" && !E164.test(v)) return true;
    return false;
  });
}

/** The verified caller-id number Twilio dials out from, or null if not configured. */
export function voiceCallerId(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.TWILIO_VOICE_CALLER_ID?.trim();
  return v && E164.test(v) ? v : null;
}

/**
 * Twilio client identities allow only letters, digits and underscore, so a
 * user id containing anything else (e.g. a UUID's hyphens) is mapped
 * deterministically. The voice webhook recomputes it to bind a call session
 * to the user who created it.
 */
export function voiceIdentity(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_]/g, "_");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface VoiceTokenResult {
  token: string;
  identity: string;
  expiresAt: string;
  ttlSeconds: number;
}

/** Mint a short-lived access token. Caller must have checked `missingVoiceEnv` is empty. */
export function mintVoiceToken(
  userId: string,
  opts: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
): VoiceTokenResult {
  const env = opts.env ?? process.env;
  const missing = missingVoiceEnv(env);
  if (missing.length > 0) throw new Error(`Voice not configured: ${missing.join(", ")}`);

  const accountSid = env.TWILIO_ACCOUNT_SID!.trim();
  const apiKeySid = env.TWILIO_API_KEY_SID!.trim();
  const apiKeySecret = env.TWILIO_API_KEY_SECRET!.trim();
  const appSid = env.TWILIO_TWIML_APP_SID!.trim();

  const iat = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const exp = iat + VOICE_TOKEN_TTL_SECONDS;
  const identity = voiceIdentity(userId);

  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${apiKeySid}-${iat}`,
    iss: apiKeySid,
    sub: accountSid,
    iat,
    nbf: iat,
    exp,
    grants: {
      identity,
      voice: {
        // Outgoing only, through our TwiML App. No `incoming` grant.
        outgoing: { application_sid: appSid },
      },
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", apiKeySecret).update(signingInput).digest("base64url");

  return {
    token: `${signingInput}.${signature}`,
    identity,
    expiresAt: new Date(exp * 1000).toISOString(),
    ttlSeconds: VOICE_TOKEN_TTL_SECONDS,
  };
}
