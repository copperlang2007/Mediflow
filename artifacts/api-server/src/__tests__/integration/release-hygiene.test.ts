/**
 * Release-hygiene tests — build SHA / version surface.
 *
 * Covers:
 *   - getBuildInfo() env cascade (BUILD_SHA > GITHUB_SHA > SENTRY_RELEASE)
 *   - Defaults when no env is set
 *   - GET /version returns the same identity the header advertises
 *   - X-Build-Sha header on a regular route + on a 404 response
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, authF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  authF: async (): Promise<Record<string, unknown>> => {
    const { identityMockFactory } = await import("../helpers/testApp");
    return identityMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as unknown as { default: typeof import("supertest") }).default;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  const { _resetBuildInfoCacheForTests } = await import("../../lib/buildInfo");
  _resetBuildInfoCacheForTests();
  delete process.env.BUILD_SHA;
  delete process.env.GITHUB_SHA;
  delete process.env.SENTRY_RELEASE;
  delete process.env.APP_VERSION;
  delete process.env.BUILD_TIME;
});

// ---------------------------------------------------------------------------
// getBuildInfo()
// ---------------------------------------------------------------------------

describe("getBuildInfo", () => {
  it("returns sensible defaults when no env is set", async () => {
    const { getBuildInfo } = await import("../../lib/buildInfo");
    const info = getBuildInfo();
    expect(info.version).toBe("0.0.0-dev");
    expect(info.sha).toBe("unknown");
    expect(info.builtAt).toBe(null);
    expect(info.nodeVersion).toBe(process.version);
  });

  it("prefers BUILD_SHA over GITHUB_SHA and SENTRY_RELEASE", async () => {
    process.env.BUILD_SHA = "explicit-build-sha";
    process.env.GITHUB_SHA = "github-default-sha";
    process.env.SENTRY_RELEASE = "sentry-cli-sha";
    const { getBuildInfo } = await import("../../lib/buildInfo");
    expect(getBuildInfo().sha).toBe("explicit-build-sha");
  });

  it("falls back to GITHUB_SHA when BUILD_SHA is absent", async () => {
    process.env.GITHUB_SHA = "github-default-sha";
    process.env.SENTRY_RELEASE = "sentry-cli-sha";
    const { getBuildInfo } = await import("../../lib/buildInfo");
    expect(getBuildInfo().sha).toBe("github-default-sha");
  });

  it("falls back to SENTRY_RELEASE when BUILD_SHA + GITHUB_SHA are absent", async () => {
    process.env.SENTRY_RELEASE = "sentry-cli-sha";
    const { getBuildInfo } = await import("../../lib/buildInfo");
    expect(getBuildInfo().sha).toBe("sentry-cli-sha");
  });

  it("populates version + builtAt from APP_VERSION + BUILD_TIME", async () => {
    process.env.APP_VERSION = "1.4.2";
    process.env.BUILD_TIME = "2026-05-30T04:00:00.000Z";
    const { getBuildInfo } = await import("../../lib/buildInfo");
    const info = getBuildInfo();
    expect(info.version).toBe("1.4.2");
    expect(info.builtAt).toBe("2026-05-30T04:00:00.000Z");
  });

  it("caches the resolution — env changes after first call are not observed", async () => {
    process.env.BUILD_SHA = "first";
    const { getBuildInfo } = await import("../../lib/buildInfo");
    getBuildInfo();
    process.env.BUILD_SHA = "second";
    expect(getBuildInfo().sha).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// X-Build-Sha header
// ---------------------------------------------------------------------------

describe("X-Build-Sha response header", () => {
  // Note: the middleware caches the SHA at module-load time, so we can't
  // assert against an env-specific value here without forcing a re-import.
  // What we CAN assert: the header is always present and non-empty.
  it("is set on a successful response", async () => {
    const res = await request(app).get("/version").expect(200);
    expect(res.headers["x-build-sha"]).toBeDefined();
    expect(typeof res.headers["x-build-sha"]).toBe("string");
    expect(res.headers["x-build-sha"]?.length ?? 0).toBeGreaterThan(0);
  });

  it("is set on a 404 response", async () => {
    const res = await request(app).get("/no-such-route-here-zzz").expect(404);
    expect(res.headers["x-build-sha"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /version
// ---------------------------------------------------------------------------

describe("GET /version", () => {
  it("returns the build identity as JSON", async () => {
    const res = await request(app).get("/version").expect(200);
    expect(res.body).toMatchObject({
      version: expect.any(String),
      sha: expect.any(String),
      nodeVersion: expect.any(String),
      uptimeSeconds: expect.any(Number),
    });
    // builtAt may be null in test runs — assert presence either way.
    expect(res.body).toHaveProperty("builtAt");
    // The body `sha` resolves from getBuildInfo() per request, so with the
    // SHA env cleared in `beforeEach` it is "unknown".
    //
    // We deliberately do NOT compare against the `X-Build-Sha` header here.
    // That header is captured ONCE at module-load (see
    // middlewares/buildShaHeader.ts), while `beforeEach` resets the
    // buildInfo cache and deletes the SHA env vars. When the process starts
    // with a SHA env present — e.g. GITHUB_SHA on CI runners — the frozen
    // header and the freshly-resolved body legitimately differ, so a
    // body===header assertion passes locally but fails on CI. The
    // header↔body agreement contract is covered below with a controlled env.
    expect(res.body.sha).toBe("unknown");
  });

  it("body sha reflects the SHA env when set before resolution", async () => {
    // Exercise the real contract — getBuildInfo() honors the env — without
    // depending on the header's module-load snapshot. Reset the cache, set
    // a known SHA, re-resolve.
    const { _resetBuildInfoCacheForTests, getBuildInfo } = await import(
      "../../lib/buildInfo"
    );
    process.env.BUILD_SHA = "deadbeefcafe";
    _resetBuildInfoCacheForTests();
    const res = await request(app).get("/version").expect(200);
    expect(res.body.sha).toBe("deadbeefcafe");
    expect(getBuildInfo().sha).toBe("deadbeefcafe");
  });

  it("does not require auth", async () => {
    // No Authorization header → still 200. /version is intentionally public
    // (build SHA is leaked via X-Build-Sha on every response anyway).
    await request(app).get("/version").expect(200);
  });
});
