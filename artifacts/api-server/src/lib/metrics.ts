/**
 * Prometheus-style metrics for the API server.
 *
 * Scope:
 *   - Default Node runtime metrics (CPU, memory, GC, event-loop lag) via
 *     prom-client's `collectDefaultMetrics`. Free baseline for any
 *     "is this server healthy" dashboard.
 *   - HTTP request histogram with `method`, `route`, `status_code` labels.
 *     Recorded by `middlewares/metricsMiddleware.ts` on response finish.
 *   - pg-boss queue-depth gauge — refreshed lazily on /metrics scrape so
 *     we don't poll pg-boss on a timer (a /metrics scrape arrives every
 *     ~30s from the typical Prometheus side; that's the natural cadence).
 *
 * Cardinality discipline:
 *   The `route` label MUST be the Express route pattern (`/agents/:id`),
 *   never the raw path (`/agents/123`). Raw paths balloon label
 *   cardinality, which blows up the Prometheus TSDB and the renderer.
 *   The middleware enforces this by reading `req.route?.path` AFTER
 *   routing; unrouted (404) requests are bucketed as `__unmatched__` so
 *   a route-scan attack can't create unbounded labels.
 *
 * The `/metrics` endpoint itself is wired in `app.ts` behind a bearer-
 * token auth check (`METRICS_TOKEN` env). The endpoint is excluded from
 * the HTTP histogram to avoid Prometheus polling its own latency into
 * the rolling window.
 */
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";
import { JOB_NAMES, peekQueue } from "./jobs";
import { logger } from "./logger";

export const metricsRegistry = new Registry();

// Default Node metrics — registers process_cpu_seconds_total,
// nodejs_eventloop_lag_seconds, nodejs_gc_duration_seconds, etc.
// Prefixed via the registry so they don't collide with custom metrics.
collectDefaultMetrics({ register: metricsRegistry, prefix: "node_" });

// ---- HTTP histograms -------------------------------------------------------

/**
 * Per-request duration histogram. The buckets are tuned for an API where
 * most requests complete in <250ms; the long tail (>1s) is where alerts
 * fire so the upper buckets are denser.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds, labelled by method/route/status",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
  ],
  registers: [metricsRegistry],
});

/**
 * Counter of completed HTTP requests. Strictly redundant with the
 * histogram's `_count` series, but Prometheus rate() queries on a counter
 * are simpler and more idiomatic for dashboards than histogram-_count
 * gymnastics. Keep both.
 */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests received",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [metricsRegistry],
});

// ---- pg-boss enqueue + dead-letter counters --------------------------------

/**
 * Total jobs successfully enqueued via `enqueue()`, labelled by queue
 * name + outcome (`accepted` | `failed`). `failed` covers the
 * never-throws fallback path inside `enqueue()` — pg-boss returned an
 * error, we logged it, and returned null. Alert on a sustained non-zero
 * rate of `outcome="failed"` — it means the queue infra is unhealthy and
 * job intake is being silently dropped.
 */
export const jobEnqueueTotal = new Counter({
  name: "pg_boss_jobs_enqueued_total",
  help: "Total jobs enqueued via enqueue(), labelled by queue and outcome",
  labelNames: ["queue", "outcome"] as const,
  registers: [metricsRegistry],
});

/**
 * Total jobs that exhausted their retry budget and landed in the
 * dead-letter queue. Labelled by the ORIGINAL queue name (what was
 * trying to run when it died), not the dead-letter queue itself —
 * that's the signal you actually want to alert on:
 * `rate(pg_boss_jobs_dead_lettered_total{queue="X"}[5m]) > 0` means
 * queue X is permanently losing jobs.
 *
 * Bumped from the dead-letter handler. Already-logged + Sentry-captured;
 * this counter is the structured signal Prometheus can alert on.
 */
export const jobDeadLetterTotal = new Counter({
  name: "pg_boss_jobs_dead_lettered_total",
  help: "Total jobs that exhausted retries and were dead-lettered, labelled by original queue",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

// ---- pg-boss queue gauges --------------------------------------------------

/**
 * Per-queue gauges, labelled per queue name + state. Refreshed on each
 * /metrics scrape via `refreshQueueGaugesIfPossible()`. Skipped silently
 * when pg-boss isn't started (test runs, degraded dev mode) — the gauges
 * keep their last values.
 *
 * Three states tracked:
 *   - queued  → ready jobs waiting for a worker. Alert when this stays
 *               high — workers can't keep up.
 *   - active  → jobs a worker is currently executing.
 *   - deferred → jobs deferred for future delivery (scheduled, retry
 *                backoff). Useful for visibility but rarely alerts.
 */
export const queueJobsGauge = new Gauge({
  name: "pg_boss_queue_jobs",
  help: "Number of pg-boss jobs by queue + state (refreshed on /metrics scrape)",
  labelNames: ["queue", "state"] as const,
  registers: [metricsRegistry],
});

/**
 * Refresh queue gauges from pg-boss. Called from the /metrics route
 * handler RIGHT BEFORE serializing the registry — Prometheus sees fresh
 * counts on each scrape, but we don't poll on a timer (would waste DB
 * IO when nobody's scraping).
 *
 * Silent on failure. A /metrics scrape MUST NOT fail because pg-boss is
 * momentarily unreachable — the scrape returns the last-known queue
 * values plus the always-fresh runtime metrics.
 */
export async function refreshQueueGaugesIfPossible(): Promise<void> {
  const boss = peekQueue();
  if (!boss) return; // pg-boss not started — skip
  try {
    // Single round-trip: getQueues() returns QueueResult[] with
    // queuedCount/activeCount/deferredCount for every queue we ask for.
    const queueNames = Object.values(JOB_NAMES) as string[];
    const results = await boss.getQueues(queueNames);
    for (const r of results) {
      queueJobsGauge.set({ queue: r.name, state: "queued" }, r.queuedCount);
      queueJobsGauge.set({ queue: r.name, state: "active" }, r.activeCount);
      queueJobsGauge.set({ queue: r.name, state: "deferred" }, r.deferredCount);
    }
  } catch (err) {
    // Per-queue failures land here (e.g. queue doesn't exist yet on
    // first boot). Log at debug so prod logs don't fill — Prometheus
    // sees the last-known values.
    logger.debug({ err }, "pg-boss queue depth refresh failed");
  }
}
