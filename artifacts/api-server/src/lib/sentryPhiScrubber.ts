/**
 * PHI scrubbing helpers for Sentry events.
 *
 * The internal security review (L3) and the subprocessor audit
 * (high-risk #3) both flag the lack of a `beforeSend` hook on Sentry.
 * A thrown DB / Zod error can include PHI field values (Medicare
 * Beneficiary IDs, SSN, phone, email) in its message, which then ships
 * to Sentry — defeating the BAA boundary.
 *
 * Strategy: regex-replace high-signal PHI patterns in any string value
 * we ship. We DO NOT regex-scrub DOB / dates because they're shape-
 * indistinguishable from ordinary timestamps and a false positive would
 * destroy operator-readable error messages. DOB scrubbing must happen
 * by field name (handled separately when needed; the BeforeSend hook
 * scrubs request bodies regardless).
 *
 * What we scrub:
 *   - Medicare Beneficiary IDs (MBI):
 *       11-char alphanumeric per CMS format, optionally dashed.
 *       Pattern: digit, letter, letter, digit, [-], letter, digit, [-],
 *                letter, letter, digit, digit
 *   - SSN: 9 digits with optional dashes (3-2-4).
 *   - Phone: E.164 (+15555550000) and common US format ((555) 555-5555).
 *   - Email addresses.
 *   - Bank routing/account: 9-digit routing + 4-17 digit account (defensive;
 *     not collected today but PR #112 added the column shape).
 *
 * What we DO NOT scrub:
 *   - event.tags (operator-curated; PHI shouldn't be there in the first place)
 *   - UUIDs, generic timestamps, ints, durations.
 */

const MBI_REGEX =
  /\b[1-9](?:[A-HJ-NP-Z][A-HJ-NP-Z])(?:\d)-?(?:[A-HJ-NP-Z])(?:\d)-?(?:[A-HJ-NP-Z])(?:[A-HJ-NP-Z])(?:\d)(?:\d)\b/gi;
// SSN: 3-2-4 with optional dashes. Pre-check is the trailing 4-digit
// block so we don't grab any 9-digit blob. Lookarounds prevent eating
// surrounding alnums.
const SSN_REGEX = /(?<![\w-])(\d{3}-\d{2}-\d{4}|\d{9})(?![\w-])/g;
const EMAIL_REGEX =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// Phone: matches +1XXXXXXXXXX (E.164 US/CA) and (XXX) XXX-XXXX / XXX-XXX-XXXX.
const PHONE_E164_REGEX = /(?<![\w])\+\d{10,15}(?![\w])/g;
const PHONE_US_REGEX =
  /(?<![\w-])(?:\(\d{3}\)\s?\d{3}-\d{4}|\d{3}-\d{3}-\d{4})(?![\w-])/g;
// Routing+Account — generic shape "9 digits separated by space/dash from
// 4-17 digit account". Pretty rare in incidental text but cheap to scrub.
const BANK_REGEX = /(?<![\w-])(\d{9})[\s-]+(\d{4,17})(?![\w-])/g;

/**
 * Apply PHI redaction to a string. Order matters: scrub the most
 * specific patterns first (MBI before SSN, etc.).
 */
export function redactPhiString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  return input
    .replace(MBI_REGEX, "[REDACTED:MBI]")
    .replace(EMAIL_REGEX, "[REDACTED:EMAIL]")
    .replace(BANK_REGEX, "[REDACTED:BANK]")
    .replace(PHONE_E164_REGEX, "[REDACTED:PHONE]")
    .replace(PHONE_US_REGEX, "[REDACTED:PHONE]")
    .replace(SSN_REGEX, "[REDACTED:SSN]");
}

/**
 * Deep-walk an arbitrary structured value and redact every string leaf.
 * Used for request bodies, extra context, breadcrumb data — places where
 * the shape is unbounded.
 *
 * Bounded recursion depth (DEFAULT_DEPTH) — Sentry payloads above ~6
 * levels of nesting are vanishingly rare and unbounded recursion on a
 * pathological event payload would risk a Sentry-loop OOM.
 */
const DEFAULT_DEPTH = 8;

export function redactPhiDeep<T>(value: T, depth = DEFAULT_DEPTH): T {
  if (depth < 0) return value;
  if (value == null) return value;

  if (typeof value === "string") {
    return redactPhiString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactPhiDeep(v, depth - 1)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPhiDeep(v, depth - 1);
    }
    return out as unknown as T;
  }
  // number / boolean / bigint / symbol / function — pass through.
  return value;
}

// Minimal shape of the Sentry event we mutate. We use a structural type
// here so this module doesn't pull `@sentry/types` into the build graph
// — that lets the regex unit tests run without the full Sentry SDK.
export interface SentryLikeEvent {
  message?: string;
  transaction?: string;
  user?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: {
        frames?: Array<{
          vars?: Record<string, unknown>;
        }>;
      };
    }>;
  };
  request?: {
    data?: unknown;
    url?: string;
    query_string?: unknown;
    headers?: Record<string, unknown>;
    cookies?: unknown;
  };
  extra?: Record<string, unknown>;
  breadcrumbs?: Array<{
    message?: string;
    data?: Record<string, unknown>;
  }>;
  // Sentry v10 (OTel-first) shape: HTTP details also land on the trace
  // context and on child spans — a query string carrying an MBI/SSN shows
  // up in request.url, request.query_string, contexts.trace.data.url.full,
  // and spans[].data simultaneously.
  contexts?: {
    trace?: {
      data?: Record<string, unknown>;
    };
  } & Record<string, unknown>;
  spans?: Array<{
    description?: string;
    data?: Record<string, unknown>;
  }>;
}

/**
 * Scrub a Sentry event payload in place. Returns the same object for
 * convenience so `beforeSend` can chain.
 *
 * NOTE: deliberately does NOT touch `event.tags` — tag values are
 * operator-curated short strings and scrubbing them would more often
 * destroy useful debugging context than catch PHI.
 */
export function scrubSentryEvent<T extends SentryLikeEvent>(event: T): T {
  if (event.message) {
    event.message = redactPhiString(event.message);
  }

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") {
        ex.value = redactPhiString(ex.value);
      }
      const frames = ex.stacktrace?.frames;
      if (frames) {
        for (const frame of frames) {
          if (frame.vars) {
            frame.vars = redactPhiDeep(frame.vars);
          }
        }
      }
    }
  }

  if (event.request) {
    if (event.request.data !== undefined) {
      event.request.data = redactPhiDeep(event.request.data);
    }
    // v10: URL, query string, headers, and cookies carry request PHI that
    // the v8 shape kept inside request.data only.
    if (typeof event.request.url === "string") {
      event.request.url = redactPhiString(event.request.url);
    }
    if (event.request.query_string !== undefined) {
      event.request.query_string = redactPhiDeep(event.request.query_string);
    }
    if (event.request.headers) {
      event.request.headers = redactPhiDeep(event.request.headers);
    }
    if (event.request.cookies !== undefined) {
      event.request.cookies = redactPhiDeep(event.request.cookies);
    }
  }

  // Defense in depth: these are empty today (no setUser calls,
  // sendDefaultPii=false, OTel records transaction as a route template),
  // but a future Sentry.setUser({ email }) or custom context bucket must
  // not become a silent PHI leak.
  if (typeof event.transaction === "string") {
    event.transaction = redactPhiString(event.transaction);
  }
  if (event.user) {
    event.user = redactPhiDeep(event.user);
  }

  // v10: OTel span attributes on the trace context (url.full, http.url,
  // http.target, http.query, http.request.header.*) — plus every other
  // contexts.* bucket, which is arbitrary structured data.
  if (event.contexts) {
    for (const [key, value] of Object.entries(event.contexts as Record<string, unknown>)) {
      if (key === "trace") continue; // handled below with its own shape
      if (value && typeof value === "object") {
        (event.contexts as Record<string, unknown>)[key] = redactPhiDeep(value);
      }
    }
  }
  if (event.contexts?.trace?.data) {
    event.contexts.trace.data = redactPhiDeep(event.contexts.trace.data);
  }

  // v10: child spans carry the same attribute shape per span.
  if (event.spans) {
    for (const span of event.spans) {
      if (typeof span.description === "string") {
        span.description = redactPhiString(span.description);
      }
      if (span.data) {
        span.data = redactPhiDeep(span.data);
      }
    }
  }

  if (event.extra) {
    event.extra = redactPhiDeep(event.extra);
  }

  if (event.breadcrumbs) {
    for (const bc of event.breadcrumbs) {
      if (typeof bc.message === "string") {
        bc.message = redactPhiString(bc.message);
      }
      if (bc.data) {
        bc.data = redactPhiDeep(bc.data);
      }
    }
  }

  return event;
}

export interface SentryLikeBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

export function scrubSentryBreadcrumb<T extends SentryLikeBreadcrumb>(
  breadcrumb: T,
): T {
  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = redactPhiString(breadcrumb.message);
  }
  if (breadcrumb.data) {
    breadcrumb.data = redactPhiDeep(breadcrumb.data);
  }
  return breadcrumb;
}
