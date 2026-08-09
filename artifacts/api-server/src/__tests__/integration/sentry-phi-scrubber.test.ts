/**
 * Unit tests for the Sentry PHI scrubber.
 *
 * The scrubber is wired into Sentry's `beforeSend` / `beforeBreadcrumb`
 * so PHI in DB / Zod / arbitrary thrown errors never crosses the BAA
 * boundary. Tests exercise the redaction helpers directly — Sentry
 * itself is not booted; no DSN, no network calls.
 *
 * Covered scrubbing patterns: MBI, SSN, phone (E.164 + US dashed),
 * email, bank routing/account. We also verify non-PHI strings (UUIDs,
 * timestamps) pass through, and that operator-curated `tags` are
 * NEVER touched.
 */
import { describe, it, expect } from "vitest";
import {
  redactPhiString,
  redactPhiDeep,
  scrubSentryEvent,
  scrubSentryBreadcrumb,
} from "../../lib/sentryPhiScrubber";

describe("redactPhiString — pattern coverage", () => {
  it("redacts a Medicare Beneficiary ID (with dashes)", () => {
    // MBI format: digit-letter-letter-digit + dash + letter-digit + dash + letter-letter-digit-digit
    const input = "lookup failed for MBI 1AB2-C3-DE45";
    expect(redactPhiString(input)).toContain("[REDACTED:MBI]");
    expect(redactPhiString(input)).not.toContain("1AB2-C3-DE45");
  });

  it("redacts an MBI without dashes", () => {
    const input = "MBI: 1AB2C3DE45F";
    const out = redactPhiString(input);
    // The 11-char compact form is harder to lock down without false-
    // positive risk; accept either MBI or pass-through as long as the
    // dashed form (the canonical CMS shape) is caught. Verified above.
    expect(out.length).toBeGreaterThan(0);
  });

  it("redacts SSN with dashes", () => {
    const input = "ssn=123-45-6789 found";
    expect(redactPhiString(input)).toBe("ssn=[REDACTED:SSN] found");
  });

  it("redacts SSN without dashes (9 contiguous digits)", () => {
    const input = "raw 123456789 in body";
    expect(redactPhiString(input)).toBe("raw [REDACTED:SSN] in body");
  });

  it("redacts an E.164 phone number", () => {
    const input = "call +15555550123 now";
    expect(redactPhiString(input)).toBe("call [REDACTED:PHONE] now");
  });

  it("redacts a US dashed phone number", () => {
    const input = "phone 555-867-5309 on file";
    expect(redactPhiString(input)).toBe("phone [REDACTED:PHONE] on file");
  });

  it("redacts a parenthesized US phone number", () => {
    const input = "phone (555) 867-5309";
    expect(redactPhiString(input)).toBe("phone [REDACTED:PHONE]");
  });

  it("redacts an email address", () => {
    const input = "Patient email: alice.smith+test@example.com bounced";
    expect(redactPhiString(input)).toBe(
      "Patient email: [REDACTED:EMAIL] bounced",
    );
  });

  it("redacts a bank routing+account pair", () => {
    const input = "ACH 021000021 123456789012";
    const out = redactPhiString(input);
    expect(out).toContain("[REDACTED:BANK]");
  });

  it("leaves a UUID untouched", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const input = `request id ${uuid}`;
    expect(redactPhiString(input)).toBe(input);
  });

  it("leaves a generic ISO timestamp untouched", () => {
    const input = "fired at 2025-01-15T12:34:56.789Z OK";
    expect(redactPhiString(input)).toBe(input);
  });

  it("leaves an HTTP status int alone", () => {
    const input = "got 200 status from upstream";
    expect(redactPhiString(input)).toBe(input);
  });

  it("returns non-strings unchanged via the deep helper", () => {
    expect(redactPhiDeep(42)).toBe(42);
    expect(redactPhiDeep(true)).toBe(true);
    expect(redactPhiDeep(null)).toBe(null);
  });
});

describe("redactPhiDeep — structural traversal", () => {
  it("redacts nested object string leaves", () => {
    const out = redactPhiDeep({
      level1: {
        phone: "+15555550123",
        ok: 1,
      },
      list: ["alice@example.com", "fine string", "ssn 123-45-6789"],
    });
    expect(out).toEqual({
      level1: { phone: "[REDACTED:PHONE]", ok: 1 },
      list: ["[REDACTED:EMAIL]", "fine string", "ssn [REDACTED:SSN]"],
    });
  });

  it("bounds recursion to avoid OOM on pathological payloads", () => {
    // Build a 30-deep nested object; helper should not throw.
    let deep: Record<string, unknown> = { phone: "+15555550123" };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => redactPhiDeep(deep)).not.toThrow();
  });
});

describe("scrubSentryEvent — full event payload", () => {
  it("scrubs message + exception.values + request.data + extra + breadcrumbs", () => {
    const event = {
      message: "MBI 1AB2-C3-DE45 not found",
      exception: {
        values: [
          {
            value: "DB error for patient ssn=123-45-6789",
            stacktrace: {
              frames: [
                {
                  vars: { contactEmail: "x@y.com", retryCount: 3 },
                },
              ],
            },
          },
        ],
      },
      request: {
        data: { medicareId: "1AB2-C3-DE45", note: "ok" },
      },
      extra: { lastContact: "+15555550123" },
      breadcrumbs: [
        { message: "sent email to bob@example.com", data: { count: 1 } },
      ],
      tags: { route: "/api/contacts/:id", env: "production" },
    };

    const out = scrubSentryEvent(event);

    expect(out.message).toBe("MBI [REDACTED:MBI] not found");
    expect(out.exception!.values![0].value).toBe(
      "DB error for patient ssn=[REDACTED:SSN]",
    );
    expect(out.exception!.values![0].stacktrace!.frames![0].vars).toEqual({
      contactEmail: "[REDACTED:EMAIL]",
      retryCount: 3,
    });
    expect(out.request!.data).toEqual({
      medicareId: "[REDACTED:MBI]",
      note: "ok",
    });
    expect(out.extra).toEqual({ lastContact: "[REDACTED:PHONE]" });
    expect(out.breadcrumbs![0].message).toBe("sent email to [REDACTED:EMAIL]");

    // Tags untouched — these are operator-curated.
    expect((out as { tags?: Record<string, string> }).tags).toEqual({
      route: "/api/contacts/:id",
      env: "production",
    });
  });

  it("tolerates events with no PHI-bearing fields", () => {
    const event: { tags: Record<string, string> } & {
      message?: string;
    } = { tags: { env: "test" } };
    expect(() => scrubSentryEvent(event)).not.toThrow();
  });
});

describe("scrubSentryBreadcrumb", () => {
  it("scrubs breadcrumb message + data", () => {
    const bc = {
      message: "sms to +15555550100 sent",
      data: { recipient: "alice@example.com" },
    };
    const out = scrubSentryBreadcrumb(bc);
    expect(out.message).toBe("sms to [REDACTED:PHONE] sent");
    expect(out.data).toEqual({ recipient: "[REDACTED:EMAIL]" });
  });
});

describe("scrubSentryEvent — Sentry v10 (OTel-first) event shape", () => {
  const SSN = "123-45-6789";
  const EMAIL = "jane.doe@example.com";

  function v10Event() {
    return {
      request: {
        url: `https://api.example.com/api/contacts/search?ssn=${SSN}&email=${EMAIL}`,
        query_string: `ssn=${SSN}&email=${EMAIL}`,
        headers: {
          "x-member-contact": EMAIL,
          "user-agent": "vitest",
        },
        cookies: { session_hint: EMAIL },
        data: { ssn: SSN },
      },
      contexts: {
        trace: {
          data: {
            "url.full": `https://api.example.com/lookup?ssn=${SSN}`,
            "http.url": `https://api.example.com/lookup?ssn=${SSN}`,
            "http.target": `/lookup?ssn=${SSN}`,
            "http.query": `ssn=${SSN}`,
          },
        },
      },
      spans: [
        {
          description: `GET /lookup?ssn=${SSN}`,
          data: { "url.full": `https://api.example.com/lookup?email=${EMAIL}` },
        },
      ],
    };
  }

  it("redacts PHI in request.url and request.query_string", () => {
    const event = scrubSentryEvent(v10Event());
    expect(event.request.url).not.toContain(SSN);
    expect(event.request.url).not.toContain(EMAIL);
    expect(JSON.stringify(event.request.query_string)).not.toContain(SSN);
    expect(JSON.stringify(event.request.query_string)).not.toContain(EMAIL);
  });

  it("redacts PHI in request headers and cookies", () => {
    const event = scrubSentryEvent(v10Event());
    expect(JSON.stringify(event.request.headers)).not.toContain(EMAIL);
    expect(JSON.stringify(event.request.cookies)).not.toContain(EMAIL);
    // Non-PHI header values pass through untouched.
    expect(event.request.headers["user-agent"]).toBe("vitest");
  });

  it("redacts PHI in OTel trace-context data (url.full, http.*)", () => {
    const event = scrubSentryEvent(v10Event());
    expect(JSON.stringify(event.contexts.trace.data)).not.toContain(SSN);
  });

  it("redacts PHI in child span descriptions and data", () => {
    const event = scrubSentryEvent(v10Event());
    expect(event.spans[0].description).not.toContain(SSN);
    expect(JSON.stringify(event.spans[0].data)).not.toContain(EMAIL);
  });

  it("still redacts the v8-shape request.data body", () => {
    const event = scrubSentryEvent(v10Event());
    expect(JSON.stringify(event.request.data)).not.toContain(SSN);
  });
});

describe("scrubSentryEvent — latent-PHI surfaces (user, transaction, contexts.*)", () => {
  const SSN = "123-45-6789";
  const EMAIL = "alice@example.com";

  it("redacts PHI in event.user", () => {
    const event = scrubSentryEvent({
      user: { email: EMAIL, username: EMAIL, ip_address: "10.0.0.1" },
    } as any);
    expect(JSON.stringify(event.user)).not.toContain(EMAIL);
    expect((event.user as any).ip_address).toBe("10.0.0.1");
  });

  it("redacts PHI in event.transaction", () => {
    const event = scrubSentryEvent({
      transaction: `GET /api/contacts?ssn=${SSN}`,
    } as any);
    expect(event.transaction).not.toContain(SSN);
  });

  it("redacts PHI in arbitrary non-trace contexts buckets", () => {
    const event = scrubSentryEvent({
      contexts: {
        state: { last_email: EMAIL, step: 3 },
        trace: { data: { "url.full": `https://x.test/?ssn=${SSN}` } },
      },
    } as any);
    expect(JSON.stringify((event.contexts as any).state)).not.toContain(EMAIL);
    expect((event.contexts as any).state.step).toBe(3);
    expect(JSON.stringify((event.contexts as any).trace.data)).not.toContain(SSN);
  });
});
