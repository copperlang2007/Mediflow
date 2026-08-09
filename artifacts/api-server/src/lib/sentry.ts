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
  scrubShallowLeaves,
} from "./sentryPhiScrubber";
import { getBuildInfo } from "./buildInfo";
import { logger } from "./logger";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (initialized) return;

  const build = getBuildInfo();

  // Env-tunable: v10's OTel-first instrumentation captures a broader span
  // surface than v8 once the --import loader flow lands, so quota burn can
  // shift. Default unchanged; lower via env without a deploy-time code edit.
  // Validate the parse: Number('high') is NaN, which Sentry maps to
  // undefined and silently discards EVERY transaction — and its own invalid-
  // rate warning is debug-build-only, so a typo'd env var would kill tracing
  // in prod with zero signal. Fall back loudly instead.
  const rawRate = process.env.SENTRY_TRACES_SAMPLE_RATE;
  let tracesSampleRate = rawRate === undefined ? 0.1 : Number(rawRate);
  if (!Number.isFinite(tracesSampleRate) || tracesSampleRate < 0 || tracesSampleRate > 1) {
    logger.warn(
      { rawRate },
      "invalid SENTRY_TRACES_SAMPLE_RATE — defaulting to 0.1",
    );
    tracesSampleRate = 0.1;
  }

  Sentry.init({
    dsn,
    tracesSampleRate,
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
    // v10 streams spans as v2 span envelopes (streamGenAiSpans defaults to
    // true) which route through beforeSendSpan — NOT beforeSendTransaction.
    // Narrow surface today (genAI integrations gate recordInputs/outputs on
    // sendDefaultPii, which is unset), but the hook must exist before anyone
    // flips those flags.
    beforeSendSpan(span) {
      try {
        scrubShallowLeaves(span as unknown as Record<string, unknown>);
        return span;
      } catch (err) {
        logger.error(
          { err, scrubberError: err instanceof Error ? err.message : String(err) },
          "PHI SCRUBBER FAILED — REDACTING SPAN FIELDS"
        );
        // Fail closed WITHOUT null: in @sentry/core v10 a null return from
        // beforeSendSpan keeps the ORIGINAL span (processedSpans.push(span)),
        // so null-drop is actually fail-open here. Blank every string-bearing
        // field instead and ship the sentinel.
        const stripped = span as unknown as Record<string, unknown>;
        for (const key of ["description", "name", "op", "status_message", "origin"]) {
          if (key in stripped) stripped[key] = "[REDACTED:SCRUB_FAILED]";
        }
        // attributes/data are Record-typed per SpanJSON — a sentinel STRING
        // here gets char-iterated by @sentry/core's serializeAttributes into
        // 23 per-character entries. Empty object keeps the span well-formed.
        for (const key of ["attributes", "data"]) {
          if (key in stripped) stripped[key] = {};
        }
        // SpanJSON.links[] each carry their own attributes bag — the same
        // PHI surface as span attributes. Keep only the structural link
        // fields; anything else ships unscrubbed past a failed scrub.
        if (Array.isArray(stripped.links)) {
          stripped.links = (stripped.links as Array<Record<string, unknown>>).map(
            (link) => ({
              span_id: link?.span_id,
              trace_id: link?.trace_id,
              sampled: link?.sampled,
              attributes: {},
            }),
          );
        }
        return span;
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