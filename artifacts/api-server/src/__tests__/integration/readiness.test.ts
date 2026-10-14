/**
 * Integration test: liveness vs. readiness probes.
 *
 * Verifies the Kubernetes-style split documented in `lib/readiness.ts`:
 *   - `/api/healthz` is always 200 regardless of subsystem state.
 *   - `/api/readyz` is 503 until workers are marked ready AND the DB
 *     responds to `SELECT 1`.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// vi.mock hoists above imports, but the factory bodies may reference
// helpers — we route through vi.hoisted to avoid TDZ.
const { dbF, authF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    const base = await dbMockFactory();
    // Wrap `db` so we can swap `db.execute` per-test to simulate failures.
    const realDb = base.db as { execute: (...args: unknown[]) => Promise<unknown> };
    const dbProxy = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          const override = globalThis.__READYZ_DB_EXECUTE_OVERRIDE__;
          if (override) return override;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { ...base, db: dbProxy };
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

declare global {
  // eslint-disable-next-line no-var
  var __READYZ_DB_EXECUTE_OVERRIDE__:
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
}

let app: Express;
let request: typeof import("supertest");
let readiness: typeof import("../../lib/readiness");

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as { default: typeof import("supertest") }).default;
  readiness = await import("../../lib/readiness");
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  readiness.__resetReadinessForTests();
  globalThis.__READYZ_DB_EXECUTE_OVERRIDE__ = undefined;
  globalThis.__READYZ_WIP_OVERRIDE__ = undefined;
});

describe("liveness — /api/healthz", () => {
  it("returns 200 even when workers are NOT ready", async () => {
    // Workers are still not-ready (reset in beforeEach).
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns 200 even when the DB would fail (does not touch DB)", async () => {
    globalThis.__READYZ_DB_EXECUTE_OVERRIDE__ = async (): Promise<never> => {
      throw new Error("db down");
    };
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("readiness — /api/readyz", () => {
  it("returns 503 before workers are marked ready", async () => {
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.checks.workers).toBe("not_ready");
  });

  it("returns 200 after markWorkersReady() AND DB is reachable", async () => {
    readiness.markWorkersReady();
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      checks: { db: "ok", workers: "ok" },
    });
  });

  it("returns 503 with checks.db='failed' when the DB query fails", async () => {
    readiness.markWorkersReady();
    globalThis.__READYZ_DB_EXECUTE_OVERRIDE__ = async (): Promise<never> => {
      throw new Error("connection refused");
    };
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.checks).toEqual({ db: "failed", workers: "ok" });
  });

  it("returns 503 with checks.db='failed' when DB query times out", async () => {
    readiness.markWorkersReady();
    globalThis.__READYZ_DB_EXECUTE_OVERRIDE__ = (): Promise<unknown> =>
      // Resolve far beyond the 500ms ping timeout.
      new Promise((resolve) => setTimeout(() => resolve(undefined), 2_000));
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks.db).toBe("failed");
  });

  it("returns 503 with checks.workers='dead' when every worker is stopped", async () => {
    // Boot-time `markWorkersReady()` fired, but pg-boss now reports every
    // worker loop as stopped — the worker-liveness gap this fix closes.
    readiness.markWorkersReady();
    globalThis.__READYZ_WIP_OVERRIDE__ = [
      { name: "send-scheduled-sms", state: "stopped" },
      { name: "send-scheduled-email", state: "stopped" },
    ];
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.checks.workers).toBe("dead");
  });

  it("returns 503 with checks.workers='dead' when pg-boss has zero workers", async () => {
    readiness.markWorkersReady();
    globalThis.__READYZ_WIP_OVERRIDE__ = [];
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks.workers).toBe("dead");
  });

  it("returns 200 when at least one worker is live and DB is reachable", async () => {
    readiness.markWorkersReady();
    globalThis.__READYZ_WIP_OVERRIDE__ = [
      { name: "send-scheduled-sms", state: "stopped" },
      { name: "run-automation-rules", state: "active" },
    ];
    const res = await request(app).get("/api/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      checks: { db: "ok", workers: "ok" },
    });
  });
});
