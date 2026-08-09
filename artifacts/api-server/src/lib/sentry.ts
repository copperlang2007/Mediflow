/**
 * Sentry wiring for the API server.
 *
 * Both helpers are no-ops when SENTRY_DSN is not set so local dev / CI
 * environments don't need any extra configuration. To enable error
 * reporting in production, set SENTRY_DSN in the environment.
 *
 * COVERAGE NOTE — auto-instrumentation is currently OUT of scope: the
 * server ships as a single esbuild bundle, and v10's OTel instrumentation
 * (import-in-the-middle) cannot hook modules that were inlined at build
 * time. Error capture and MANUAL spans (Sentry.startSpan) work fully and
 * route through the PHI-scrubbing hooks below; HTTP/pg/express auto-spans
 * do not attach. Wiring the full surface means externalizing @sentry/node
 * from the bundle and starting with `--import @sentry/node/preload` — a
 * deploy-entrypoint change deliberately deferred (pending Lang's sign-off).
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
  // in prod with zero signal. Fall back loudly instead. Blank/whitespace
  // counts as UNSET, not zero: Number('') is 0, a valid rate that would
  // silently disable tracing while dodging the warn path below. An explicit
  // '0' still means "tracing off" — that's a deliberate operator choice.
  const rawRate = process.env.SENTRY_TRACES_SAMPLE_RATE?.trim();
  let tracesSampleRate = rawRate === undefined || rawRate === "" ? 0.1 : Number(rawRate);
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
        // so null-drop is actually fail-open here. Instead, KEEP only the
        // structural identifiers and blank everything else — an
        // enumerate-to-scrub list would silently pass any field a future SDK
        // adds (links[].attributes, events[].attributes, v11 surfaces…);
        // a keep-list defaults new fields to redacted. Strings get the
        // sentinel; objects/arrays become empty (a sentinel STRING on the
        // Record-typed attributes/data gets char-iterated by @sentry/core's
        // serializeAttributes into per-character entries).
        // REACHABILITY: scrubShallowLeaves handles per-key failures itself
        // (hostile getters / descriptor throws delete the key and continue),
        // so this outer branch only fires on STRUCTURAL failures — in
        // practice an Object.keys()/ownKeys throw (revoked or hostile
        // Proxy). It is a narrow last-resort net, not general coverage; do
        // not weaken the per-key try/catch on the assumption this catches
        // what it misses.
        // Caveat (unverified against live ingest): if Sentry's v2 span
        // pipeline ever rejects envelopes whose op/origin carry this
        // sentinel, the degraded span is dropped server-side — an
        // acceptable outcome for a path that only fires on a structural
        // scrub failure, and strictly better than shipping PHI.
        const STRUCTURAL_KEEP = new Set([
          "span_id", "trace_id", "parent_span_id",
          "start_timestamp", "timestamp", "is_segment", "status",
        ]);
        const stripped = span as unknown as Record<string, unknown>;
        for (const key of Object.keys(stripped)) {
          if (STRUCTURAL_KEEP.has(key)) continue;
          const value = stripped[key];
          if (typeof value === "string") {
            stripped[key] = "[REDACTED:SCRUB_FAILED]";
          } else if (value && typeof value === "object") {
            stripped[key] = Array.isArray(value) ? [] : {};
          }
          // numbers/booleans (exclusive_time, sampled…) carry no PHI — keep.
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