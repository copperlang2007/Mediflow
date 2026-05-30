/**
 * Express middleware that records per-request metrics into the HTTP
 * histogram + counter exported by `lib/metrics.ts`.
 *
 * Cardinality discipline:
 *   The `route` label is `req.route?.path` (the Express route PATTERN,
 *   e.g. `/agents/:id`), NOT `req.path` (the raw URL, e.g. `/agents/123`).
 *   This is the canonical guard against label-cardinality blowup — a
 *   raw-path label would let any URL probe create a new TSDB series.
 *
 * Unrouted requests (path didn't match any route → 404) bucket into
 * `route="__unmatched__"`. This is intentional: it surfaces in the
 * dashboard as "how many 404s are we serving?" without letting an
 * attacker create unbounded series by hammering random URLs.
 *
 * Ordering: this middleware must be registered EARLY in app.ts (before
 * routes) so the response-finish listener fires at the right time for
 * every request. Routing has not yet happened when the middleware
 * itself runs — that's fine, we read `req.route` inside the listener
 * after the route layer has populated it.
 */
import type { Request, Response, NextFunction } from "express";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from "../lib/metrics";

/**
 * Routes whose metrics are intentionally NOT recorded. Today this is
 * just `/metrics` itself — including it would have Prometheus's own
 * scrape latency loop back into the histogram, polluting the p99.
 */
const EXCLUDED_PATHS = new Set(["/metrics"]);

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Skip the scrape endpoint to keep its self-noise out of the histogram.
  if (EXCLUDED_PATHS.has(req.path)) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  // `finish` fires when the response is fully sent (after headers + body).
  // `close` fires on premature client disconnect — we still want to
  // record latency for those, but they'll show with whatever status
  // Express set before the disconnect.
  let recorded = false;
  const record = (): void => {
    if (recorded) return;
    recorded = true;
    const durationNs = process.hrtime.bigint() - startedAt;
    const durationSec = Number(durationNs) / 1e9;
    // Read route AFTER the route layer has set it. For unrouted
    // requests (404) `req.route` is undefined — bucket those into a
    // bounded sentinel.
    const route = req.route?.path ?? "__unmatched__";
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestDurationSeconds.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  };

  res.on("finish", record);
  res.on("close", record);

  next();
}
