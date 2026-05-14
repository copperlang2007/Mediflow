/**
 * Unit-level coverage for the graceful HTTP shutdown sequence.
 *
 * The actual `process.on("SIGTERM", ...)` wiring in `index.ts` is one line
 * and excluded from coverage per the PR scope. What matters is the ordering
 * contract inside `shutdown()`:
 *
 *   1. `server.close()` is called immediately (drain starts).
 *   2. `boss.stop({ graceful: true })` is called AFTER the close callback fires
 *      — never before. Routes that enqueue jobs during the drain must succeed.
 *   3. If the close callback doesn't fire within the timeout, `exit(1)` is
 *      called and `boss.stop` is NOT invoked (we're force-killing).
 *   4. The signal name is logged on entry so operators can correlate pod
 *      termination events with our logs.
 *
 * We inject fakes for `server`, `getBoss`, `exit`, `setTimer`/`clearTimer`,
 * and `logger` so the suite runs synchronously without real sockets.
 */
import { describe, it, expect, vi } from "vitest";

import {
  shutdown,
  resolveShutdownTimeoutMs,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ShutdownBoss,
  type ShutdownLogger,
  type ShutdownServer,
} from "../../lib/shutdown";

function makeLogger(): ShutdownLogger & {
  infos: Array<Record<string, unknown>>;
  warns: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const infos: Array<Record<string, unknown>> = [];
  const warns: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  return {
    infos,
    warns,
    errors,
    info: (obj): void => {
      infos.push(obj);
    },
    warn: (obj): void => {
      warns.push(obj);
    },
    error: (obj): void => {
      errors.push(obj);
    },
  };
}

interface FakeServer extends ShutdownServer {
  triggerClose: (err?: Error) => void;
  closeCalled: boolean;
}

function makeFakeServer(): FakeServer {
  let cb: ((err?: Error) => void) | undefined;
  const server: FakeServer = {
    closeCalled: false,
    close(callback: (err?: Error) => void): unknown {
      this.closeCalled = true;
      cb = callback;
      return this;
    },
    triggerClose(err?: Error): void {
      if (!cb) throw new Error("server.close was never called");
      cb(err);
    },
  };
  return server;
}

function makeFakeBoss(): ShutdownBoss & {
  stopCallCount: number;
  stopOpts: Array<{ graceful: true }>;
} {
  const stopOpts: Array<{ graceful: true }> = [];
  return {
    stopCallCount: 0,
    stopOpts,
    async stop(opts: { graceful: true }): Promise<void> {
      this.stopCallCount += 1;
      stopOpts.push(opts);
    },
  };
}

describe("shutdown()", () => {
  it("calls server.close() and resolves when its callback fires", async () => {
    const server = makeFakeServer();
    const boss = makeFakeBoss();
    const exit = vi.fn();
    const logger = makeLogger();

    const promise = shutdown("SIGTERM", {
      server,
      getBoss: async () => boss,
      exit: exit as unknown as (code: number) => void,
      logger,
      timeoutMs: 30_000,
    });

    expect(server.closeCalled).toBe(true);
    // Boss must not stop until after the drain callback resolves.
    expect(boss.stopCallCount).toBe(0);

    // Simulate all sockets having drained.
    server.triggerClose();
    await promise;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("stops pg-boss AFTER server.close resolves", async () => {
    const server = makeFakeServer();
    const events: string[] = [];

    const server2: ShutdownServer = {
      close(callback): unknown {
        events.push("server.close");
        // Defer the callback by a microtask so the ordering claim is
        // observable — if boss.stop ran synchronously off the close call,
        // it would land before "drain-complete".
        queueMicrotask(() => {
          events.push("drain-complete");
          callback();
        });
        return this;
      },
    };

    const boss: ShutdownBoss = {
      async stop(): Promise<void> {
        events.push("boss.stop");
      },
    };

    await shutdown("SIGTERM", {
      server: server2,
      getBoss: async () => boss,
      exit: () => undefined,
      logger: makeLogger(),
      timeoutMs: 30_000,
    });

    expect(events).toEqual(["server.close", "drain-complete", "boss.stop"]);
    // Silence unused-var lint by referencing the unused helper instance.
    expect(server.closeCalled).toBe(false);
  });

  it("forces exit(1) if the drain doesn't finish within the timeout, and skips boss.stop", async () => {
    const server = makeFakeServer();
    const boss = makeFakeBoss();
    const exit = vi.fn();
    const logger = makeLogger();

    // Capture the timer callback so the test can fire it synchronously
    // without waiting for real wall-clock time.
    let firedTimer: (() => void) | undefined;
    const setTimer = (fn: () => void): { unref?: () => void } => {
      firedTimer = fn;
      return { unref: (): void => undefined };
    };

    const promise = shutdown("SIGTERM", {
      server,
      getBoss: async () => boss,
      exit: exit as unknown as (code: number) => void,
      logger,
      setTimer,
      clearTimer: () => undefined,
      timeoutMs: 30_000,
    });

    expect(server.closeCalled).toBe(true);
    expect(firedTimer).toBeDefined();

    // Fire the timeout — drain never completes.
    firedTimer?.();

    await promise;

    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledTimes(1);
    // boss.stop MUST NOT run after a force-exit path.
    expect(boss.stopCallCount).toBe(0);

    // The timeout branch should produce an error-level log so operators can
    // see the force-exit in production logs.
    expect(
      logger.errors.some(
        (e) =>
          typeof e["timeoutMs"] === "number" &&
          typeof e["signal"] === "string",
      ),
    ).toBe(true);
  });

  it("logs the signal name on entry", async () => {
    const server = makeFakeServer();
    const boss = makeFakeBoss();
    const logger = makeLogger();

    const promise = shutdown("SIGINT", {
      server,
      getBoss: async () => boss,
      exit: () => undefined,
      logger,
      timeoutMs: 30_000,
    });
    server.triggerClose();
    await promise;

    expect(logger.infos[0]).toMatchObject({
      signal: "SIGINT",
      timeoutMs: 30_000,
    });
  });

  it("skips boss.stop cleanly when getBoss() returns null (degraded-mode pod)", async () => {
    const server = makeFakeServer();
    const exit = vi.fn();

    const promise = shutdown("SIGTERM", {
      server,
      getBoss: async () => null,
      exit: exit as unknown as (code: number) => void,
      logger: makeLogger(),
      timeoutMs: 30_000,
    });
    server.triggerClose();
    await promise;

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 if boss.stop throws — a failed job queue shouldn't wedge the pod", async () => {
    const server = makeFakeServer();
    const exit = vi.fn();
    const logger = makeLogger();
    const boss: ShutdownBoss = {
      async stop(): Promise<void> {
        throw new Error("boom");
      },
    };

    const promise = shutdown("SIGTERM", {
      server,
      getBoss: async () => boss,
      exit: exit as unknown as (code: number) => void,
      logger,
      timeoutMs: 30_000,
    });
    server.triggerClose();
    await promise;

    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.errors.length).toBeGreaterThan(0);
  });
});

describe("resolveShutdownTimeoutMs()", () => {
  it("returns the default when the env var is unset", () => {
    expect(resolveShutdownTimeoutMs(undefined)).toBe(
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(30_000);
  });

  it("parses a positive numeric override", () => {
    expect(resolveShutdownTimeoutMs("5000")).toBe(5_000);
  });

  it("falls back to the default on garbage or non-positive values", () => {
    expect(resolveShutdownTimeoutMs("not-a-number")).toBe(
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    expect(resolveShutdownTimeoutMs("0")).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(resolveShutdownTimeoutMs("-1")).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });
});
