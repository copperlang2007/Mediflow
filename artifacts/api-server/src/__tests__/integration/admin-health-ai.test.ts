/**
 * Integration tests for GET /admin/health/ai — the admin-only AI provider
 * health check.
 *
 * Mocking strategy:
 *   - We vi.mock the `openai` package so constructing an `OpenAI`/`AzureOpenAI`
 *     instance never reaches a real network. The mock surfaces a controllable
 *     `chat.completions.create` whose behavior the test can swap per case
 *     (success, auth error, timeout/abort, etc.).
 *   - Env vars are set BEFORE the routes module loads so `getOpenAI()`'s
 *     memoized client uses the mock. We reset that memoization via
 *     `_resetOpenAIClient()` between cases so each test gets a fresh client.
 *   - The actual `chat.completions.create` is reassigned per-test via a
 *     module-scope `currentCreateImpl` ref the mock factory closes over.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ---- Per-test create() impl ref --------------------------------------------
// Module-scope so the vi.mock factory (which is hoisted) can read it via the
// closure created inside `vi.hoisted`. Tests overwrite this between cases.
const { dbF, clerkF, jobsF, openaiF, openaiState } = vi.hoisted(() => {
  const state: { createImpl: ((...args: unknown[]) => unknown) | null } = {
    createImpl: null,
  };

  class FakeClient {
    public chat = {
      completions: {
        create: async (...args: unknown[]): Promise<unknown> => {
          if (!state.createImpl) {
            throw new Error("Test did not set state.createImpl before calling chat.completions.create");
          }
          return state.createImpl(...args);
        },
      },
    };
  }

  return {
    dbF: async (): Promise<Record<string, unknown>> => {
      const { dbMockFactory } = await import("../helpers/testApp");
      return dbMockFactory();
    },
    clerkF: async (): Promise<Record<string, unknown>> => {
      const { clerkMockFactory } = await import("../helpers/testApp");
      return clerkMockFactory();
    },
    jobsF: async (): Promise<Record<string, unknown>> => {
      const { jobsMockFactory } = await import("../helpers/testApp");
      return jobsMockFactory();
    },
    openaiF: (): Record<string, unknown> => ({
      default: FakeClient,
      AzureOpenAI: FakeClient,
      OpenAI: FakeClient,
    }),
    openaiState: state,
  };
});

vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("openai", openaiF);

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let resetOpenAIClient: () => void;

let org: { id: string };
let superAdmin: { id: string };
let agencyAdmin: { id: string };
let nonAdmin: { id: string };

// We use the API_KEY value `super-secret-test-key-bytes-abc123` to assert
// the bytes never leak into the response. The string is intentionally
// unusual so a regex absence check is meaningful.
const TEST_API_KEY = "super-secret-test-key-bytes-abc123";

function setAzureEnv(): void {
  process.env.AI_INTEGRATIONS_PROVIDER = "azure";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = TEST_API_KEY;
  process.env.AI_INTEGRATIONS_AZURE_RESOURCE = "mediflow-test";
  process.env.AI_INTEGRATIONS_AZURE_API_VERSION = "2024-02-15-preview";
  process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT = "gpt-4o";
}

function clearAiEnv(): void {
  delete process.env.AI_INTEGRATIONS_PROVIDER;
  delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  delete process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
  delete process.env.AI_INTEGRATIONS_AZURE_API_VERSION;
  delete process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT;
  delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
}

beforeAll(async () => {
  setAzureEnv();

  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  // Memoized client lives inside routes/ai.ts; reset it between tests so
  // we always get a fresh FakeClient backed by the current state.createImpl.
  const aiModule = await import("../../routes/ai");
  resetOpenAIClient = aiModule._resetOpenAIClient;

  org = await seedOrg(handle.db, { id: "admin-health-ai-org" });
  superAdmin = await seedUser(handle.db, { orgId: org.id, role: "super_admin" });
  agencyAdmin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  nonAdmin = await seedUser(handle.db, { orgId: org.id, role: "agent_support" });
});

afterAll(async () => {
  clearAiEnv();
  await shutdownTestDb();
});

beforeEach(() => {
  // Reset state between cases. Default impl is set per-test.
  openaiState.createImpl = null;
  resetOpenAIClient();
  // Re-apply env (some tests mutate it) so the next test starts from a
  // known-good Azure config.
  setAzureEnv();
});

/**
 * Seed a fresh super_admin so a test gets a clean per-(orgId,userId)
 * rate-limit budget. The /admin/health/ai cap is 6/min, so tests that
 * share a user across cases collide quickly — using a fresh seed is the
 * simplest isolation.
 */
async function freshAdmin(): Promise<{ id: string }> {
  const { db } = (await import("@workspace/db")) as unknown as { db: unknown };
  const { seedUser } = await import("../helpers/testDb");
  return seedUser(db as never, { orgId: org.id, role: "super_admin" });
}

describe("GET /admin/health/ai — auth & RBAC", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/admin/health/ai");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin (agent_support)", async () => {
    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(nonAdmin.id));
    expect(res.status).toBe(403);
  });

  it("returns 200 for super_admin with a configured provider", async () => {
    openaiState.createImpl = async () => ({
      model: "gpt-4o",
      choices: [{ message: { content: "ok" } }],
    });

    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(superAdmin.id));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("azure");
    expect(res.body.configured).toBe(true);
    expect(res.body.envValid).toBe(true);
    expect(res.body.envIssues).toEqual([]);
    expect(res.body.ping.ok).toBe(true);
    expect(res.body.ping.model).toBe("gpt-4o");
    expect(typeof res.body.ping.latencyMs).toBe("number");
  });

  it("returns 200 for agency_admin too", async () => {
    openaiState.createImpl = async () => ({
      model: "gpt-4o",
      choices: [{ message: { content: "ok" } }],
    });

    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(agencyAdmin.id));

    expect(res.status).toBe(200);
    expect(res.body.ping.ok).toBe(true);
  });
});

describe("GET /admin/health/ai — provider error categorization", () => {
  it("maps a 401 upstream auth error to category='auth_failed'", async () => {
    openaiState.createImpl = async () => {
      const err = Object.assign(new Error("upstream said no"), {
        status: 401,
        name: "AuthenticationError",
      });
      throw err;
    };

    const u = await freshAdmin();
    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(u.id));

    expect(res.status).toBe(200);
    expect(res.body.ping.ok).toBe(false);
    expect(res.body.ping.category).toBe("auth_failed");
    // Clean redacted message — no echo of "upstream said no".
    expect(res.body.ping.message).not.toContain("upstream said no");
  });

  it("maps an AbortError / timeout to category='timeout'", async () => {
    // Simulate a slow upstream that observes the AbortSignal.
    openaiState.createImpl = async (_body: unknown, opts: { signal?: AbortSignal } = {}): Promise<never> => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        });
      });
    };

    // Cut the timeout aggressively by forcing a fake-timer-like manual
    // abort: easiest is to monkey-patch setTimeout to fire immediately
    // for THIS one test. Vitest gives us vi.useFakeTimers, but we're
    // inside a supertest request that does real I/O, so instead we
    // shorten the wait by patching the global timeout. Cleaner: temporarily
    // replace setTimeout to fire fast for the admin-health code path.
    // We do this by setting AbortController on the next tick via a stub.
    //
    // Simpler approach: rely on the route's 10s timeout and let the
    // request actually wait. To avoid a 10-second test we skip the wait
    // by short-circuiting: the test framework runs with a 30s testTimeout,
    // so 10s is acceptable but slow. Instead, monkey-patch global
    // setTimeout so the route's 10s timer fires almost immediately.
    const originalSetTimeout = global.setTimeout;
    const patchedSetTimeout = ((fn: (...a: unknown[]) => void, ms?: number): NodeJS.Timeout => {
      // Only short-circuit the long (>= 5s) timer the route uses; leave
      // everything else (express internals, etc.) alone.
      const fireIn = typeof ms === "number" && ms >= 5_000 ? 10 : ms;
      return originalSetTimeout(fn, fireIn);
    }) as unknown as typeof global.setTimeout;
    // Preserve the static method properties (Node augments setTimeout with `.unref`, etc.)
    Object.assign(patchedSetTimeout, originalSetTimeout);
    global.setTimeout = patchedSetTimeout;

    try {
      const u = await freshAdmin();
      const res = await request(app)
        .get("/api/admin/health/ai")
        .set(withAuth(u.id));

      expect(res.status).toBe(200);
      expect(res.body.ping.ok).toBe(false);
      expect(res.body.ping.category).toBe("timeout");
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it("maps a 429 rate-limit error to category='rate_limited'", async () => {
    openaiState.createImpl = async () => {
      throw Object.assign(new Error("slow down"), {
        status: 429,
        name: "RateLimitError",
      });
    };

    const u = await freshAdmin();
    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(u.id));

    expect(res.body.ping.ok).toBe(false);
    expect(res.body.ping.category).toBe("rate_limited");
  });

  it("maps a 404 to category='not_found'", async () => {
    openaiState.createImpl = async () => {
      throw Object.assign(new Error("deployment missing"), {
        status: 404,
        name: "NotFoundError",
      });
    };

    const u = await freshAdmin();
    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(u.id));

    expect(res.body.ping.ok).toBe(false);
    expect(res.body.ping.category).toBe("not_found");
  });
});

describe("GET /admin/health/ai — rate limit", () => {
  it("returns 429 on the 7th call within 60s from the same user", async () => {
    openaiState.createImpl = async () => ({
      model: "gpt-4o",
      choices: [{ message: { content: "ok" } }],
    });

    const rateUser = await freshAdmin();
    const headers = withAuth(rateUser.id);
    for (let i = 0; i < 6; i++) {
      const res = await request(app).get("/api/admin/health/ai").set(headers);
      expect(res.status).not.toBe(429);
    }
    const blocked = await request(app).get("/api/admin/health/ai").set(headers);
    expect(blocked.status).toBe(429);
  });
});

describe("GET /admin/health/ai — defense in depth", () => {
  it("never echoes the API key bytes in the response body", async () => {
    // Cover: success path
    openaiState.createImpl = async () => ({
      model: "gpt-4o",
      choices: [{ message: { content: "ok" } }],
    });
    const u1 = await freshAdmin();
    const ok = await request(app).get("/api/admin/health/ai").set(withAuth(u1.id));
    const okText = JSON.stringify(ok.body);
    expect(okText).not.toContain(TEST_API_KEY);
    expect(okText).not.toMatch(/super-secret-test-key/);

    // Cover: error path (errors are the most likely accidental leak vector)
    openaiState.createImpl = async () => {
      throw Object.assign(new Error(`401 — key ${TEST_API_KEY} was rejected`), {
        status: 401,
        name: "AuthenticationError",
      });
    };
    const u2 = await freshAdmin();
    const err = await request(app).get("/api/admin/health/ai").set(withAuth(u2.id));
    const errText = JSON.stringify(err.body);
    expect(errText).not.toContain(TEST_API_KEY);
    expect(errText).not.toMatch(/super-secret-test-key/);
  });

  it("reports envIssues when AI_INTEGRATIONS_OPENAI_API_KEY is missing", async () => {
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    resetOpenAIClient();

    // Use a dedicated user — the shared superAdmin's per-minute budget may
    // already be depleted by earlier cases in this file.
    const envUser = await freshAdmin();
    const res = await request(app)
      .get("/api/admin/health/ai")
      .set(withAuth(envUser.id));

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.envValid).toBe(false);
    expect(res.body.envIssues).toContain("AI_INTEGRATIONS_OPENAI_API_KEY missing");
    expect(res.body.ping.ok).toBe(false);
  });
});
