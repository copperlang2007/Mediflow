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
import { getBuildInfo } from "./buildInfo";
import { logger } from "./logger";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (initialized) return;

  const build = getBuildInfo();
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? "development",
    // Tie events to the deploy artifact. The cascade in buildInfo.ts
    // falls back to "unknown" — Sentry accepts that as a release name,
    // so local dev / untagged builds still ship events (just bucketed
    // under "unknown" rather than a SHA).
    release: build.sha,
    // PHI scrubbing — see lib/sentryPhiScrubber.ts. Strips MBI, SSN,
    // email, phone, bank routing patterns from event payloads + breadcrumbs
    // before they leave the process. Defense-in-depth so a thrown DB / Zod
    // error containing a Medicare ID never crosses the BAA boundary.
    beforeSend(event) {
      if (!initialized) return null;
      try {
        // Type-safe scrub
        const eventShape = event as unknown as Record<string, any>;
        scrubSentryEvent(eventShape);
        // If scrubbing succeeded, send the event
        return event;
      } catch (err) {
        // CRITICAL: Scrubber failed — log and HALT transmission
        logger.error(
          { 
            err, 
            eventKeys: Object.keys(event || {}),
            scrubberError: err instanceof Error ? err.message : String(err),
          },
          "PHI SCRUBBER FAILED — HALTING SENTRY EVENT TRANSMISSION"
        );
        // Return null to DROP event (safer than shipping unscrubbed PHI)
        return null;
      }
    },
    // beforeSend covers ERROR events only — transactions route through
    // beforeSendTransaction. Without this hook, v10's OTel-first HTTP shape
    // ships request.url / query_string / contexts.trace.data unscrubbed,
    // punching PHI straight through the BAA boundary.
    beforeSendTransaction(event) {
      if (!initialized) return null;
      try {
        const eventShape = event as unknown as Record<string, any>;
        scrubSentryEvent(eventShape);
        return event;
      } catch (err) {
        logger.error(
          {
            err,
            eventKeys: Object.keys(event || {}),
            scrubberError: err instanceof Error ? err.message : String(err),
          },
          "PHI SCRUBBER FAILED — HALTING SENTRY TRANSACTION TRANSMISSION"
        );
        // Fail closed: drop the transaction rather than ship unscrubbed PHI.
        return null;
      }
    },
    beforeBreadcrumb(breadcrumb) {
      if (!initialized) return breadcrumb;
      try {
        scrubSentryBreadcrumb(
          breadcrumb as unknown as Parameters<typeof scrubSentryBreadcrumb>[0],
        );
        return breadcrumb;
      } catch (err) {
        logger.warn(
          { err, breadcrumbType: (breadcrumb as any)?.type },
          "PHI scrubber: breadcrumb scrub failed — dropping"
        );
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