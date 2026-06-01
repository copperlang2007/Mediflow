/**
 * Unit tests for the production env guard (`lib/prodEnvGuard.ts`).
 *
 * The guard is the L1 finding from the internal security review: a
 * misconfigured prod deploy that ships `NODE_ENV=test` (or unset) would
 * silently weaken `requireMfa` (which bypasses for every role in test
 * mode) and fall back to a deterministic dev sentinel for PHI encryption
 * keys. The guard refuses to boot in that misconfiguration.
 *
 * No network / DB — pure env-var heuristic.
 */
import { describe, it, expect } from "vitest";
import {
  assertProdEnvIntegrity,
  detectProdLikeCredentials,
  type ProdEnvGuardEnv,
} from "../../lib/prodEnvGuard";

const PROD_DB = "postgres://app:secret@db.prod.example.com:5432/mediflow";
const DEV_DB = "postgres://test:test@localhost:5432/test";
const LOOPBACK_DB = "postgres://test:test@127.0.0.1:5432/test";
const PROD_CLERK_SK = "sk_live_dummy_secret_key_value_for_test";
const PROD_CLERK_PK = "pk_live_dummy_publishable_key_value";
const TEST_CLERK_SK = "sk_test_dummy";
const TEST_CLERK_PK = "pk_test_dummy";
const PROD_PHI_KEY = Buffer.alloc(32, 0x11).toString("base64");

describe("detectProdLikeCredentials", () => {
  it("returns no reasons for an all-dev env", () => {
    const env: ProdEnvGuardEnv = {
      DATABASE_URL: DEV_DB,
      CLERK_SECRET_KEY: TEST_CLERK_SK,
      CLERK_PUBLISHABLE_KEY: TEST_CLERK_PK,
    };
    expect(detectProdLikeCredentials(env)).toEqual([]);
  });

  it("treats 127.0.0.1 as loopback (no reason)", () => {
    const env: ProdEnvGuardEnv = { DATABASE_URL: LOOPBACK_DB };
    expect(detectProdLikeCredentials(env)).toEqual([]);
  });

  it("flags a non-loopback DATABASE_URL host", () => {
    const env: ProdEnvGuardEnv = { DATABASE_URL: PROD_DB };
    const reasons = detectProdLikeCredentials(env);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((r) => r.includes("DATABASE_URL"))).toBe(true);
  });

  it("flags a live Clerk secret key", () => {
    const env: ProdEnvGuardEnv = { CLERK_SECRET_KEY: PROD_CLERK_SK };
    const reasons = detectProdLikeCredentials(env);
    expect(reasons.some((r) => r.includes("sk_live"))).toBe(true);
  });

  it("flags a live Clerk publishable key", () => {
    const env: ProdEnvGuardEnv = { CLERK_PUBLISHABLE_KEY: PROD_CLERK_PK };
    const reasons = detectProdLikeCredentials(env);
    expect(reasons.some((r) => r.includes("pk_live"))).toBe(true);
  });

  it("flags an explicitly-set PHI_ENCRYPTION_KEY (no dev sentinel)", () => {
    const env: ProdEnvGuardEnv = { PHI_ENCRYPTION_KEY: PROD_PHI_KEY };
    const reasons = detectProdLikeCredentials(env);
    expect(reasons.some((r) => r.includes("PHI_ENCRYPTION_KEY"))).toBe(true);
  });

  it("does not crash on an unparseable DATABASE_URL", () => {
    const env: ProdEnvGuardEnv = { DATABASE_URL: "not a url" };
    expect(() => detectProdLikeCredentials(env)).not.toThrow();
  });
});

describe("assertProdEnvIntegrity", () => {
  it("throws when NODE_ENV=test but DATABASE_URL points at a prod host", () => {
    expect(() =>
      assertProdEnvIntegrity({
        NODE_ENV: "test",
        DATABASE_URL: PROD_DB,
        CLERK_SECRET_KEY: TEST_CLERK_SK,
      }),
    ).toThrow(/FATAL: production-looking credentials/);
  });

  it("throws when NODE_ENV=test with live Clerk keys", () => {
    expect(() =>
      assertProdEnvIntegrity({
        NODE_ENV: "test",
        DATABASE_URL: DEV_DB,
        CLERK_SECRET_KEY: PROD_CLERK_SK,
        CLERK_PUBLISHABLE_KEY: PROD_CLERK_PK,
      }),
    ).toThrow(/sk_live/);
  });

  it("throws when NODE_ENV=development with prod creds", () => {
    expect(() =>
      assertProdEnvIntegrity({
        NODE_ENV: "development",
        DATABASE_URL: PROD_DB,
      }),
    ).toThrow(/FATAL/);
  });

  it("throws when NODE_ENV is unset with prod creds", () => {
    expect(() =>
      assertProdEnvIntegrity({
        DATABASE_URL: PROD_DB,
      }),
    ).toThrow(/<unset>/);
  });

  it("does NOT throw when NODE_ENV=production with prod creds", () => {
    expect(() =>
      assertProdEnvIntegrity({
        NODE_ENV: "production",
        DATABASE_URL: PROD_DB,
        CLERK_SECRET_KEY: PROD_CLERK_SK,
        CLERK_PUBLISHABLE_KEY: PROD_CLERK_PK,
        PHI_ENCRYPTION_KEY: PROD_PHI_KEY,
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=test with dev creds (current default)", () => {
    expect(() =>
      assertProdEnvIntegrity({
        NODE_ENV: "test",
        DATABASE_URL: DEV_DB,
        CLERK_SECRET_KEY: TEST_CLERK_SK,
        CLERK_PUBLISHABLE_KEY: TEST_CLERK_PK,
      }),
    ).not.toThrow();
  });

  it("invokes the supplied logger.fatal before throwing", () => {
    const calls: Array<{ obj: unknown; msg: string }> = [];
    const logger = {
      fatal: (obj: unknown, msg: string): void => {
        calls.push({ obj, msg });
      },
    };
    expect(() =>
      assertProdEnvIntegrity(
        {
          NODE_ENV: "test",
          DATABASE_URL: PROD_DB,
        },
        logger,
      ),
    ).toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].msg).toMatch(/FATAL/);
  });
});

describe("assertProdEnvIntegrity — DEMO_MODE", () => {
  it("allows a remote demo DB when DEMO_MODE is on and no real creds present", () => {
    // The demo runs on a managed host, so a non-loopback DATABASE_URL is
    // expected and must NOT block boot on its own.
    expect(() =>
      assertProdEnvIntegrity({
        DEMO_MODE: "true",
        NODE_ENV: "development",
        DATABASE_URL: PROD_DB,
      }),
    ).not.toThrow();
  });

  it("refuses to boot when DEMO_MODE is paired with NODE_ENV=production", () => {
    expect(() =>
      assertProdEnvIntegrity({ DEMO_MODE: "true", NODE_ENV: "production" }),
    ).toThrow(/DEMO_MODE/);
  });

  it("refuses to boot when DEMO_MODE is paired with a live Clerk secret key", () => {
    // The auth-bypassing demo build must never sit in front of real creds.
    expect(() =>
      assertProdEnvIntegrity({
        DEMO_MODE: "true",
        NODE_ENV: "development",
        CLERK_SECRET_KEY: PROD_CLERK_SK,
      }),
    ).toThrow(/DEMO_MODE/);
  });

  it("refuses to boot when DEMO_MODE is paired with an explicit PHI key", () => {
    expect(() =>
      assertProdEnvIntegrity({
        DEMO_MODE: "true",
        NODE_ENV: "development",
        PHI_ENCRYPTION_KEY: PROD_PHI_KEY,
      }),
    ).toThrow(/DEMO_MODE/);
  });
});
