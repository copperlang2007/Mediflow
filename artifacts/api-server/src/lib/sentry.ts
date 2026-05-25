/**
 * Sentry wiring for the API server.
 *
 * Both helpers are no-ops when SENTRY_DSN is not set so local dev / CI
 * environments don't need any extra configuration. To enable error
 * reporting in production, set SENTRY_DSN in the environment.
 */

import * as Sentry from "@sentry/node";
import {
  scrubSentryEvent,
  scrubSentryBreadcrumb,
} from "./sentryPhiScrubber";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (initialized) return;

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? "development",
    // PHI scrubbing — see lib/sentryPhiScrubber.ts. Strips MBI, SSN,
    // email, phone, bank routing patterns from event payloads + breadcrumbs
    // before they leave the process. Defense-in-depth so a thrown DB / Zod
    // error containing a Medicare ID never crosses the BAA boundary.
    beforeSend(event) {
      try {
        // The scrubber mutates a structural subset of Sentry's ErrorEvent;
        // we cast to the structural shape, mutate, and return the original
        // event reference so the SDK's discriminator (`type` etc.) survives.
        scrubSentryEvent(event as unknown as Parameters<typeof scrubSentryEvent>[0]);
        return event;
      } catch {
        // Never let scrubbing crash the SDK — drop the event on failure
        // (safer than shipping unscrubbed).
        return null;
      }
    },
    beforeBreadcrumb(breadcrumb) {
      try {
        scrubSentryBreadcrumb(
          breadcrumb as unknown as Parameters<typeof scrubSentryBreadcrumb>[0],
        );
        return breadcrumb;
      } catch {
        return null;
      }
    },
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
