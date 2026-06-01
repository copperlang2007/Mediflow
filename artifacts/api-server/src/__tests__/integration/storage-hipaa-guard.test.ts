/**
 * Unit test: storage boot guard (`lib/objectStorage.ts`).
 *
 * Uploaded documents (signed PDFs, contracting packets, etc.) routinely
 * embed PHI and are stored under `PRIVATE_OBJECT_DIR` in GCS. A production
 * deploy that forgot to configure that bucket would otherwise fail only on
 * the first document operation. `assertStorageBackendHipaaCompliant()` is
 * called at boot (see `index.ts`) so the misconfiguration is caught
 * immediately instead.
 *
 * The guard only reads env vars — it makes no network calls and needs no
 * DB. `objectStorage` does transitively import `@workspace/db`, which
 * throws at import time unless DATABASE_URL is set, so we set a dummy URL
 * and load the module via dynamic import in `beforeAll` (after the env is
 * in place; a static import would be hoisted above the assignment).
 * Mirrors `ai-provider-hipaa-guard.test.ts`.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";

let assertStorageBackendHipaaCompliant: () => void;

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_PRIVATE_DIR = process.env.PRIVATE_OBJECT_DIR;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  ({ assertStorageBackendHipaaCompliant } = await import(
    "../../lib/objectStorage"
  ));
});

function restore(): void {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_PRIVATE_DIR === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = ORIGINAL_PRIVATE_DIR;
}

afterEach(restore);

describe("storage boot guard — production", () => {
  it("throws when PRIVATE_OBJECT_DIR is unset in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.PRIVATE_OBJECT_DIR;

    expect(() => assertStorageBackendHipaaCompliant()).toThrow(
      /PRIVATE_OBJECT_DIR must be set/,
    );
  });

  it("throws when PRIVATE_OBJECT_DIR is blank/whitespace in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PRIVATE_OBJECT_DIR = "   ";

    expect(() => assertStorageBackendHipaaCompliant()).toThrow(
      /PRIVATE_OBJECT_DIR must be set/,
    );
  });

  it("does NOT throw when PRIVATE_OBJECT_DIR is configured in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PRIVATE_OBJECT_DIR = "/my-bucket/private";

    expect(() => assertStorageBackendHipaaCompliant()).not.toThrow();
  });
});

describe("storage boot guard — non-production (lenient)", () => {
  it("does NOT throw with PRIVATE_OBJECT_DIR unset in test env", () => {
    process.env.NODE_ENV = "test";
    delete process.env.PRIVATE_OBJECT_DIR;

    expect(() => assertStorageBackendHipaaCompliant()).not.toThrow();
  });

  it("does NOT throw with PRIVATE_OBJECT_DIR unset in development env", () => {
    process.env.NODE_ENV = "development";
    delete process.env.PRIVATE_OBJECT_DIR;

    expect(() => assertStorageBackendHipaaCompliant()).not.toThrow();
  });

  it("does NOT throw with PRIVATE_OBJECT_DIR unset when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    delete process.env.PRIVATE_OBJECT_DIR;

    expect(() => assertStorageBackendHipaaCompliant()).not.toThrow();
  });
});
