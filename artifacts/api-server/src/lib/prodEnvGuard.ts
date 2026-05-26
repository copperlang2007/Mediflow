/**
 * Production environment guard.
 *
 * The app today permits `NODE_ENV=test` (or unset) to silently weaken
 * multiple safeguards: `requireMfa` is bypassed for *every* role, and the
 * PHI encryption helpers fall back to a deterministic dev sentinel key. A
 * misconfigured prod deploy that ships `NODE_ENV=test` would therefore
 * silently process real PHI with the dev sentinel key — exactly the L1
 * finding from the internal security review.
 *
 * This guard runs once at bootstrap. It is a SHAPE check, not a perfect
 * authentication check: we look at a small set of high-signal env
 * variables (database URL, Clerk keys, PHI encryption key) and ask
 * "do these look like prod credentials?" If they do, but `NODE_ENV`
 * is not exactly the string "production", we refuse to boot.
 *
 * Heuristic — keep it stupid:
 *   - DATABASE_URL host is anything other than `localhost` / `127.0.0.1`
 *     → production-looking.
 *   - CLERK_SECRET_KEY starts with `sk_live` → production-looking.
 *     (Test keys start with `sk_test`; dev / mock keys start with
 *     `sk_test_dummy` in the test harness.)
 *   - CLERK_PUBLISHABLE_KEY starts with `pk_live` → production-looking.
 *   - PHI_ENCRYPTION_KEY is set (test/dev fall back to a dev sentinel,
 *     so any explicitly-set key is production-looking).
 *
 * In production NODE_ENV the existing per-module guards already enforce
 * required env vars + provider choice (see `aiProvider.ts`,
 * `medicareId.ts`), so this function is a no-op there.
 */

// Structural typing for the logger so this module isn't tied to pino's
// exact (overloaded) LogFn signature — tests can pass a hand-rolled
// `{ fatal(obj, msg) }` shim and the real `logger` from `./logger.ts`
// satisfies it just as well.
export interface FatalLogger {
  fatal(obj: unknown, msg: string): void;
}

export interface ProdEnvGuardEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
  CLERK_SECRET_KEY?: string | undefined;
  CLERK_PUBLISHABLE_KEY?: string | undefined;
  PHI_ENCRYPTION_KEY?: string | undefined;
}

/**
 * Returns the list of reasons the supplied env looks like a production
 * deploy. Empty list means "looks like dev/test". Exported for tests.
 */
export function detectProdLikeCredentials(env: ProdEnvGuardEnv): string[] {
  const reasons: string[] = [];

  // DATABASE_URL — if set and points at a non-loopback host, that's prod-looking.
  const dbUrl = env.DATABASE_URL;
  if (dbUrl) {
    try {
      // Drizzle / pg accepts `postgres://` and `postgresql://` URLs.
      const parsed = new URL(dbUrl);
      const host = parsed.hostname.toLowerCase();
      if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        reasons.push(`DATABASE_URL host "${host}" is not localhost/127.0.0.1`);
      }
    } catch {
      // Unparseable URL — defer to other heuristics rather than crash.
    }
  }

  const sk = env.CLERK_SECRET_KEY;
  if (sk && sk.startsWith("sk_live")) {
    reasons.push("CLERK_SECRET_KEY starts with sk_live");
  }

  const pk = env.CLERK_PUBLISHABLE_KEY;
  if (pk && pk.startsWith("pk_live")) {
    reasons.push("CLERK_PUBLISHABLE_KEY starts with pk_live");
  }

  // PHI_ENCRYPTION_KEY: in test/dev the helper falls back to a dev sentinel
  // when unset, so any explicit value is treated as a real production key.
  // The dev/test mock factories never set this variable.
  if (env.PHI_ENCRYPTION_KEY && env.PHI_ENCRYPTION_KEY.length > 0) {
    reasons.push("PHI_ENCRYPTION_KEY is set (not a dev sentinel)");
  }

  return reasons;
}

/**
 * Throws if production-looking credentials are paired with a NODE_ENV that
 * is not exactly `"production"`. Otherwise no-op.
 *
 * Call once at bootstrap, BEFORE any other init that might consume the
 * credentials.
 */
export function assertProdEnvIntegrity(
  env: ProdEnvGuardEnv = process.env,
  logger?: FatalLogger,
): void {
  const reasons = detectProdLikeCredentials(env);
  if (reasons.length === 0) {
    // Looks like a dev/test deploy — nothing to do.
    return;
  }
  if (env.NODE_ENV === "production") {
    // Real prod with prod creds — the existing per-module guards take over.
    return;
  }

  const message =
    `FATAL: production-looking credentials detected but NODE_ENV=` +
    `${env.NODE_ENV ?? "<unset>"} (expected "production"). ` +
    `Refusing to boot to prevent silent weakening of MFA enforcement ` +
    `and PHI encryption. Reasons: ${reasons.join("; ")}`;
  logger?.fatal({ reasons, nodeEnv: env.NODE_ENV }, message);
  throw new Error(message);
}
