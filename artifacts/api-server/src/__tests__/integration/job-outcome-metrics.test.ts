/**
 * Tests for the pg-boss job outcome counters:
 *   - `pg_boss_jobs_dead_lettered_total{queue}` — bumped from the
 *     dead-letter handler when a job exhausts its retry budget.
 *   - `pg_boss_jobs_enqueued_total{queue,outcome}` — bumped from
 *     `enqueue()` on both the success path (`accepted`) and the
 *     never-throws fallback (`failed`).
 *
 * These metrics are the structured signals Ops alerts on. The dead-letter
 * counter in particular is the canonical "are we permanently losing jobs?"
 * signal — silent data loss otherwise. Tests below assert that:
 *   - The label set is correct (the original queue name survives the
 *     dead-letter envelope).
 *   - Multiple dead-letter jobs in a single batch produce one increment
 *     each (the handler iterates).
 *   - The "unknown" sentinel is used when the dead-letter payload is
 *     missing the original queue name.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
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
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
// Note: NO mock of `../../lib/jobs` here — these tests exercise the real
// deadLetterHandler import.

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";

let deadLetterHandler: typeof import("../../lib/jobs").deadLetterHandler;
let metricsRegistry: typeof import("../../lib/metrics").metricsRegistry;

beforeAll(async () => {
  await bootTestDb();
  const jobsMod = await import("../../lib/jobs");
  deadLetterHandler = jobsMod.deadLetterHandler;
  const metricsMod = await import("../../lib/metrics");
  metricsRegistry = metricsMod.metricsRegistry;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

// ---------------------------------------------------------------------------
// deadLetterHandler → pg_boss_jobs_dead_lettered_total
// ---------------------------------------------------------------------------

describe("pg_boss_jobs_dead_lettered_total", () => {
  it("increments labelled by the ORIGINAL queue name (not 'dead-letter')", async () => {
    // The dead-letter envelope wraps the original job: `data.name` is the
    // original queue, `data.state` carries the failure state.
    await deadLetterHandler([
      {
        id: "dl-1",
        data: {
          name: "license-expiry-check",
          state: "failed",
          retryCount: 5,
          output: { error: "boom" },
        },
      } as unknown as Parameters<typeof deadLetterHandler>[0][number],
    ]);

    const body = await metricsRegistry.metrics();
    expect(body).toContain(
      'pg_boss_jobs_dead_lettered_total{queue="license-expiry-check"} 1',
    );
    // The dead-letter QUEUE name itself must NOT appear as a label —
    // that's the whole point of preserving the original queue name.
    expect(body).not.toContain('queue="dead-letter"');
  });

  it("bumps once per job in a batch", async () => {
    await deadLetterHandler([
      {
        id: "dl-1",
        data: { name: "license-expiry-check", state: "failed" },
      },
      {
        id: "dl-2",
        data: { name: "license-expiry-check", state: "failed" },
      },
      {
        id: "dl-3",
        data: { name: "license-expiry-check", state: "failed" },
      },
    ] as unknown as Parameters<typeof deadLetterHandler>[0]);

    const body = await metricsRegistry.metrics();
    expect(body).toContain(
      'pg_boss_jobs_dead_lettered_total{queue="license-expiry-check"} 3',
    );
  });

  it("uses 'unknown' label when the payload is missing the original queue name", async () => {
    await deadLetterHandler([
      {
        id: "dl-corrupt",
        // No `data.name` — simulates a corrupt or pre-v12 payload.
        data: { state: "failed" },
      } as unknown as Parameters<typeof deadLetterHandler>[0][number],
    ]);

    const body = await metricsRegistry.metrics();
    expect(body).toContain('pg_boss_jobs_dead_lettered_total{queue="unknown"} 1');
  });

  it("partitions counters per queue name", async () => {
    await deadLetterHandler([
      { id: "a", data: { name: "license-expiry-check", state: "failed" } },
      { id: "b", data: { name: "cert-expiry-check", state: "failed" } },
      { id: "c", data: { name: "license-expiry-check", state: "failed" } },
    ] as unknown as Parameters<typeof deadLetterHandler>[0]);

    const body = await metricsRegistry.metrics();
    expect(body).toContain(
      'pg_boss_jobs_dead_lettered_total{queue="license-expiry-check"} 2',
    );
    expect(body).toContain(
      'pg_boss_jobs_dead_lettered_total{queue="cert-expiry-check"} 1',
    );
  });
});
