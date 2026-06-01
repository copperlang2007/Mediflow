/**
 * Short-lived RS256 service JWT minting for the dialer control plane
 * (spec §4.1 / §5).
 *
 * MediFlow → dialer control-plane calls authenticate with an asymmetric
 * (RS256) service JWT. MediFlow publishes its JWKS; the dialer verifies the
 * token against it (audience `mediflow:dialer:control`, issuer `mediflow`).
 *
 * This module deliberately uses Node's built-in `crypto` (no new runtime
 * dependency) to sign/verify compact JWTs. The signing key is injectable so
 * tests run with an ephemeral keypair and no network.
 */
import crypto from "crypto";

export const DIALER_CONTROL_AUDIENCE = "mediflow:dialer:control";
export const SERVICE_JWT_ISSUER = "mediflow";
/** Tokens are intentionally short-lived (spec §4: "short-lived"). */
export const DEFAULT_TTL_SECONDS = 5 * 60;

export interface ServiceJwtClaims {
  iss: string;
  aud: string;
  sub?: string;
  iat: number;
  exp: number;
  /** Correlates the token to the dial ticket it was minted for. */
  dialTicketId?: string;
  orgId?: string;
  [claim: string]: unknown;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export interface SignServiceJwtOptions {
  /** RS256 private key (PEM). */
  privateKey: crypto.KeyObject | string;
  /** Optional `kid` header — lets the dialer pick the right JWKS entry. */
  keyId?: string;
  audience?: string;
  issuer?: string;
  subject?: string;
  ttlSeconds?: number;
  nowSeconds?: number;
  additionalClaims?: Record<string, unknown>;
}

/** Mint a compact RS256 JWT for a control-plane request. */
export function signServiceJwt(opts: SignServiceJwtOptions): string {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (opts.keyId) header.kid = opts.keyId;

  const payload: ServiceJwtClaims = {
    iss: opts.issuer ?? SERVICE_JWT_ISSUER,
    aud: opts.audience ?? DIALER_CONTROL_AUDIENCE,
    iat: now,
    exp: now + ttl,
    ...(opts.subject ? { sub: opts.subject } : {}),
    ...opts.additionalClaims,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    opts.privateKey,
  );
  return `${signingInput}.${base64url(signature)}`;
}

export type VerifyServiceJwtResult =
  | { ok: true; claims: ServiceJwtClaims }
  | { ok: false; reason: string };

/**
 * Verify a compact RS256 JWT with the matching public key. Used by tests
 * (the mock dialer) and available for any reverse callback path; the real
 * dialer verifies via MediFlow's JWKS (spec §4).
 */
export function verifyServiceJwt(args: {
  token: string;
  publicKey: crypto.KeyObject | string;
  audience?: string;
  issuer?: string;
  nowSeconds?: number;
}): VerifyServiceJwtResult {
  const {
    token,
    publicKey,
    audience = DIALER_CONTROL_AUDIENCE,
    issuer = SERVICE_JWT_ISSUER,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = args;

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string };
  let claims: ServiceJwtClaims;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
    claims = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (header.alg !== "RS256") return { ok: false, reason: "bad_alg" };

  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
    publicKey,
    base64urlDecode(sigB64),
  );
  if (!verified) return { ok: false, reason: "bad_signature" };

  if (claims.iss !== issuer) return { ok: false, reason: "bad_issuer" };
  if (claims.aud !== audience) return { ok: false, reason: "bad_audience" };
  if (typeof claims.exp === "number" && nowSeconds >= claims.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

/**
 * Resolve MediFlow's service-JWT signing key from the environment.
 *
 * `DIALER_SERVICE_JWT_PRIVATE_KEY` holds the RS256 private key (PEM). Returns
 * undefined when unset so callers can fail explicitly. The key is injectable
 * on the issuance service so tests never need a real key.
 */
export function resolveSigningKeyFromEnv():
  | { privateKey: string; keyId?: string }
  | undefined {
  const privateKey = process.env.DIALER_SERVICE_JWT_PRIVATE_KEY;
  if (!privateKey) return undefined;
  return {
    privateKey: privateKey.replace(/\\n/g, "\n"),
    keyId: process.env.DIALER_SERVICE_JWT_KEY_ID,
  };
}
