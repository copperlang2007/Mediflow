/**
 * Sentry wiring for the API server.
 *
 * Both helpers are no-ops when SENTRY_DSN is not set so local dev / CI
 * environments don't need any extra configuration. To enable error
 * reporting in production, set SENTRY_DSN in the environment.
 */

import * as Sentry from "@sentry/node";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (initialized) return;

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? "development",
  });

  initialized = true;
}

export function captureWorkerError(
  err: unknown,
  context: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!initialized) return;
  // Sentry tag values must be primitives; coerce defensively.
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(context)) {
    if (v === undefined || v === null) continue;
    tags[k] = String(v);
  }
  Sentry.captureException(err, { tags });
}
