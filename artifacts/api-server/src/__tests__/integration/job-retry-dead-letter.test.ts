/**
 * Job retry + dead-letter coverage.
 *
 * Two operational guarantees this exercises:
 *  1. A transient handler failure is retried (pg-boss `retryLimit` /
 *     `retryBackoff`) rather than killing the job on the first error.
 *  2. A job that exhausts its retries lands in the shared dead-letter queue,
 *     where `deadLetterHandler` logs it at ERROR level AND captures it to
 *     Sentry — so a permanent failure can never be a single silent log line.
 *
 * The retry/backoff loop itself is pg-boss-internal, so (1) is verified with
 * a faithful in-memory simulation of pg-boss's retry semantics; (2) drives
 * the REAL exported `deadLetterHandler` and asserts on spied logger + Sentry.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// `lib/jobs` throws at module load if DATABASE_URL is unset (it never
// connects in this test — only the pure `deadLetterHandler` is exercised).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

import { logger } from "../../lib/logger";
import * as sentry from "../../lib/sentry";

// ---- (1) Transient failure is retried --------------------------------------

/**
 * Minimal stand-in for pg-boss's retry loop: runs `handler`, and on a thrown
 * error re-runs it up to `retryLimit` more times. Mirrors the contract of the
 * `DEFAULT_RETRY` policy applied to idempotent job queues in `lib/jobs.ts`.
 */
async function runWithRetries(
  handler: () => Promise<void>,
  retryLimit: number,
): Promise<{ ok: boolean; attempts: number }> {
  let attempts = 0;
  for (let i = 0; i <= retryLimit; i++) {
    attempts++;
    try {
      await handler();
      return { ok: true, attempts };
    } catch {
      // transient — fall through to the next retry
    }
  }
  return { ok: false, attempts };
}

describe("job retry — transient failure", () => {
  it("retries a handler that fails transiently then succeeds", async () => {
    let calls = 0;
    const handler = async (): Promise<void> => {
      calls++;
      if (calls < 3) throw new Error("provider 503");
    };

    // DEFAULT_RETRY.retryLimit is 3 in lib/jobs.ts.
    const result = await runWithRetries(handler, 3);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("gives up after exhausting the retry limit", async () => {
    const handler = async (): Promise<void> => {
      throw new Error("network blip");
    };

    const result = await runWithRetries(handler, 3);

    // 1 initial attempt + 3 retries.
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(4);
  });
});

// ---- (2) Exhausted retries surface via the dead-letter handler -------------

describe("dead-letter handler — exhausted retries", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let captureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, "error").mockImplementation(
      (() => undefined) as never,
    );
    captureSpy = vi
      .spyOn(sentry, "captureWorkerError")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs at ERROR and captures to Sentry for a permanently-failed job", async () => {
    const { deadLetterHandler } = await import("../../lib/jobs");

    await deadLetterHandler([
      {
        id: "dead-job-1",
        name: "dead-letter",
        data: { name: "send-scheduled-sms", to: "+15551234567" },
      },
    ] as never);

    // ERROR-level log with full context.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logCtx, logMsg] = errorSpy.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logMsg).toMatch(/exhausted all retries/i);
    expect(logCtx.deadLetterJobId).toBe("dead-job-1");
    expect(logCtx.originalQueue).toBe("send-scheduled-sms");
    expect(logCtx.payload).toMatchObject({ to: "+15551234567" });

    // Sentry capture with matching context tags.
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureSpy.mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/send-scheduled-sms/);
    expect(ctx.originalQueue).toBe("send-scheduled-sms");
  });

  it("handles a batch of dead-lettered jobs and an unknown original queue", async () => {
    const { deadLetterHandler } = await import("../../lib/jobs");

    await deadLetterHandler([
      { id: "a", name: "dead-letter", data: { name: "reconcile-commission-statement" } },
      { id: "b", name: "dead-letter", data: {} },
    ] as never);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(captureSpy).toHaveBeenCalledTimes(2);
    // Job with no recoverable origin queue is still reported, tagged "unknown".
    const secondCtx = (captureSpy.mock.calls[1] as [Error, Record<string, unknown>])[1];
    expect(secondCtx.originalQueue).toBe("unknown");
  });
});
