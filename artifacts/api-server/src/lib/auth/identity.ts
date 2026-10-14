/**
 * Sign-in with Google Cloud Identity Platform (ADR 0006).
 *
 * The browser signs in with the Firebase Auth SDK and sends the resulting ID
 * token, either as `Authorization: Bearer <token>` (API calls) or in the
 * `__session` cookie (downloads, EventSource streams: anything a browser
 * requests on its own). `identityMiddleware` verifies the token once per
 * request against Google's published keys and the project's issuer and
 * audience, and `getAuth(req)` returns what it proved. A missing, expired or
 * forged token simply leaves the request signed out; routes decide what that
 * means (requireAuth answers 401).
 *
 * Only facts from a verified token are used: the subject (the identity's
 * stable id), the email and whether Identity Platform has verified it, whether
 * this sign-in passed a second factor, and the issue / sign-in times. Nothing
 * from the token is logged.
 *
 * Config: IDENTITY_PLATFORM_PROJECT_ID (falls back to GOOGLE_CLOUD_PROJECT).
 */
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { logger } from "../logger";

export const IDENTITY_PROVIDER = "identity_platform";
export const SESSION_COOKIE = "__session";
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/** Allowed clock difference between Google and this server. */
const CLOCK_TOLERANCE_SEC = 60;

export interface IdentityAuth {
  /** Identity Platform user id (the token's `sub`). Not necessarily `users.id`: see lib/auth/users.ts. */
  subject: string | null;
  /**
   * One sign-in: the subject plus the time the user signed in. Stays the same
   * while the browser refreshes its token and changes on every new sign-in,
   * which is what the inactivity timeout keys on.
   */
  sessionId: string | null;
  email: string | null;
  emailVerified: boolean;
  /** This sign-in passed a second factor (TOTP). */
  mfa: boolean;
  /** Token issue time and sign-in time (seconds since epoch). */
  sessionClaims: { iat: number; auth_time: number } | null;
}

const SIGNED_OUT: IdentityAuth = { subject: null, sessionId: null, email: null, emailVerified: false, mfa: false, sessionClaims: null };
const AUTH = Symbol("identityAuth");

export function identityProjectId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = (env.IDENTITY_PLATFORM_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  return id || null;
}

let keys: JWTVerifyGetKey | null = null;
/** Tests verify real signatures against their own key set. */
export function setIdentityKeysForTests(k: JWTVerifyGetKey | null): void {
  keys = k;
}
function signingKeys(): JWTVerifyGetKey {
  // jose caches the key set and refetches when Google rotates keys.
  keys ??= createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 60 * 60 * 1000 });
  return keys;
}

/** Verify an Identity Platform ID token; null when it is not one this project issued and still valid. */
export async function verifyIdToken(token: string, projectId: string | null = identityProjectId()): Promise<IdentityAuth | null> {
  if (!projectId || !token) return null;
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, signingKeys(), {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SEC,
      requiredClaims: ["sub", "iat", "exp", "auth_time"],
    }));
  } catch (err) {
    // An expired token is routine (the browser refreshes hourly); anything else is worth a look.
    if (!(err instanceof joseErrors.JWTExpired)) logger.debug({ errName: (err as Error).name }, "Identity token rejected");
    return null;
  }
  const sub = payload.sub;
  const authTime = payload.auth_time;
  const iat = payload.iat;
  if (typeof sub !== "string" || !sub || sub.length > 128) return null;
  if (typeof authTime !== "number" || typeof iat !== "number") return null;
  if (authTime > Date.now() / 1000 + CLOCK_TOLERANCE_SEC) return null;
  const firebase = (payload.firebase ?? {}) as { sign_in_second_factor?: unknown; tenant?: unknown };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
  return {
    subject: sub,
    sessionId: `${sub}:${authTime}`,
    email: email || null,
    emailVerified: payload.email_verified === true,
    mfa: typeof firebase.sign_in_second_factor === "string" && firebase.sign_in_second_factor.length > 0,
    sessionClaims: { iat, auth_time: authTime },
  };
}

/** Most `__session` cookies tried per request (a stale one from an older sign-in can sit next to the current one). */
const MAX_COOKIE_TOKENS = 3;

/** Candidate tokens, best first: the Bearer header, then each `__session` cookie. */
function tokensFrom(req: Request): string[] {
  const out: string[] = [];
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t) out.push(t);
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      if (out.length >= MAX_COOKIE_TOKENS + 1) break;
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
        const v = part.slice(eq + 1).trim();
        if (!v) continue;
        try {
          out.push(decodeURIComponent(v));
        } catch {
          // not a token
        }
      }
    }
  }
  return out;
}

/** Verify the request's token, if any, and remember the result for getAuth. Never rejects a request itself. */
export function identityMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    let auth: IdentityAuth = SIGNED_OUT;
    for (const token of tokensFrom(req)) {
      const verified = await verifyIdToken(token);
      if (verified) {
        auth = verified;
        break;
      }
    }
    (req as unknown as Record<symbol, IdentityAuth>)[AUTH] = auth;
    next();
  };
}

/** What the request's token proved (signed out when there was none, or it failed). */
export function getAuth(req: Request): IdentityAuth {
  return (req as unknown as Record<symbol, IdentityAuth | undefined>)[AUTH] ?? SIGNED_OUT;
}
