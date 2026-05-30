/**
 * /metrics endpoint + middleware integration tests.
 *
 * Covers:
 *   - Histogram + counter are populated by the HTTP middleware on real
 *     requests, with the correct method/route/status_code labels.
 *   - The route label uses the Express PATTERN (e.g. `/livez`), not the
 *     raw path — this is the cardinality guard.
 *   - Unrouted requests (404) bucket into `route="__unmatched__"`.
 *   - The /metrics endpoint itself is excluded from the histogram (so
 *     Prometheus scrape latency doesn't loop back in).
 *   - Auth: bearer token required when METRICS_TOKEN is set; 401 on
 *     mismatch.
 *   - Non-prod fall-through: METRICS_TOKEN unset + NODE_ENV != production
 *     → endpoint serves without auth.
 *   - Prom-format response: content-type matches what prom-client emits
 *     and the body contains expected metric names.
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
  // Reset the metrics registry between tests so a counter incremented
  // in one test doesn't bleed into another's assertions.
  const { metricsRegistry } = await import("../../lib/metrics");
  metricsRegistry.resetMetrics();
  // Reset env so each test owns its own auth contract.
  delete process.env.METRICS_TOKEN;
});

// ---------------------------------------------------------------------------
// HTTP middleware → histogram
// ---------------------------------------------------------------------------

describe("metrics middleware", () => {
  it("records a histogram observation + counter increment for matched routes", async () => {
    // /api/healthz exists and is unauthenticated — perfect for hitting
    // through the full middleware chain.
    await request(app).get("/api/healthz").expect(200);

    const { metricsRegistry } = await import("../../lib/metrics");
    const body = await metricsRegistry.metrics();
    // Counter should now contain a labelled series for the route.
    expect(body).toContain(
      'http_requests_total{method="GET",route="/healthz",status_code="200"}',
    );
    expect(body).toContain('http_request_duration_seconds');
  });

  it("buckets unrouted (404) requests as route=__unmatched__ to bound cardinality", async () => {
    await request(app).get("/this-route-does-not-exist-12345").expect(404);

    const { metricsRegistry } = await import("../../lib/metrics");
    const body = await metricsRegistry.metrics();
    expect(body).toContain(
      'http_requests_total{method="GET",route="__unmatched__",status_code="404"}',
    );
    // And the raw URL must NOT appear as a label — that's the cardinality bug.
    expect(body).not.toContain('this-route-does-not-exist-12345');
  });

  it("does NOT record the /metrics endpoint itself in the histogram", async () => {
    await request(app).get("/metrics").expect(200);
    await request(app).get("/metrics").expect(200);

    const { metricsRegistry } = await import("../../lib/metrics");
    const body = await metricsRegistry.metrics();
    // Even after multiple scrapes, /metrics never appears as a route label.
    expect(body).not.toContain('route="/metrics"');
  });
});

// ---------------------------------------------------------------------------
// /metrics endpoint
// ---------------------------------------------------------------------------

describe("GET /metrics", () => {
  it("serves Prometheus text format when METRICS_TOKEN is unset (non-prod)", async () => {
    const res = await request(app).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toMatch(
      /text\/plain.*version=0\.0\.4/,
    );
    // prom-client default metrics: node_process_cpu_seconds_total et al.
    expect(res.text).toContain("# HELP node_process_cpu_seconds_total");
    expect(res.text).toContain("# HELP http_request_duration_seconds");
    expect(res.text).toContain("# HELP http_requests_total");
  });

  it("requires bearer auth when METRICS_TOKEN is set — 401 on missing", async () => {
    process.env.METRICS_TOKEN = "test-token-abc";
    await request(app).get("/metrics").expect(401);
  });

  it("requires bearer auth when METRICS_TOKEN is set — 401 on wrong token", async () => {
    process.env.METRICS_TOKEN = "test-token-abc";
    await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer wrong-token")
      .expect(401);
  });

  it("requires bearer auth when METRICS_TOKEN is set — 200 on correct token", async () => {
    process.env.METRICS_TOKEN = "test-token-abc";
    await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer test-token-abc")
      .expect(200);
  });

  it("returns 503 in production when METRICS_TOKEN is unset", async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await request(app).get("/metrics").expect(503);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
