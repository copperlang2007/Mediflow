/**
 * Graceful shutdown sequencing for the API server.
 *
 * Why this exists as its own module:
 *   The shutdown path in `index.ts` previously called `boss.stop()` and then
 *   `process.exit(0)` immediately. In-flight HTTP requests were dropped on
 *   pod termination — including partial audit-log writes. For HIPAA-relevant
 *   workloads that's a correctness bug: the access-log entry might persist
 *   while the underlying action's transaction rolls back, or vice versa.
 *
 * Ordering (matches the contract documented in the PR brief):
 *   1. Stop accepting new connections (`server.close()` triggers drain).
 *   2. Wait for in-flight requests to finish (server.close callback).
 *   3. If drain exceeds `SHUTDOWN_TIMEOUT_MS` (default 30s, matching the
 *      k8s `terminationGracePeriodSeconds` default), force `exit(1)`.
 *   4. THEN stop pg-boss gracefully — workers can finish their current job.
 *      We deliberately stop boss AFTER HTTP drain so routes that enqueue
 *      jobs during the drain don't fail.
 *   5. `exit(0)`.
 *
 * The function is parameterised on `server`/`getBoss`/`exit`/`now`/`logger`
 * so tests can drive it without spinning up sockets or real signals.
 */
import type { Server } from "node:http";

import { logger as defaultLogger } from "./logger";

export interface ShutdownServer {
  close(callback: (err?: Error) => void): unknown;
}

export interface ShutdownBoss {
  stop(opts: { graceful: true }): Promise<unknown> | unknown;
}

export interface ShutdownLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ShutdownDeps {
  server: ShutdownServer;
  /**
   * Lazy accessor so we don't connect to pg-boss just to shut it down if it
   * was never started (e.g. degraded-mode startup in non-production).
   * Return `null` to skip the boss stop step entirely.
   */
  getBoss: () => Promise<ShutdownBoss | null>;
  exit: (code: number) => void;
  /** Override for tests; defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** Override for tests; defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
  /** Override for tests; defaults to the shared pino logger. */
  logger?: ShutdownLogger;
  /** Override for tests; defaults to `Number(process.env.SHUTDOWN_TIMEOUT_MS)`. */
  timeoutMs?: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export function resolveShutdownTimeoutMs(
  raw: string | undefined,
  fallback: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Execute the graceful-shutdown sequence. Resolves after `exit` has been
 * called (tests stub `exit`; in production it terminates the process).
 *
 * Errors from `server.close` or `boss.stop` are logged but never thrown —
 * we still want to reach `exit(0)` so the pod doesn't hang waiting for a
 * promise rejection nobody handles.
 */
export async function shutdown(
  signal: string,
  deps: ShutdownDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const setTimer = deps.setTimer ?? ((fn, ms): { unref?: () => void } => {
    const handle = setTimeout(fn, ms);
    // Best-effort: don't let the drain timer keep the event loop alive on
    // its own. Some test doubles won't expose `unref`, hence the optional.
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    return handle as unknown as { unref?: () => void };
  });
  const clearTimer = deps.clearTimer ?? ((handle): void => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  });
  const timeoutMs =
    deps.timeoutMs ??
    resolveShutdownTimeoutMs(process.env["SHUTDOWN_TIMEOUT_MS"]);

  log.info({ signal, timeoutMs }, "Shutdown signal received");

  // -- Step 1+2: stop accepting new sockets and wait for the drain. --------
  let timedOut = false;
  const drain = new Promise<void>((resolve, reject) => {
    const timer = setTimer(() => {
      timedOut = true;
      log.error(
        { signal, timeoutMs },
        "HTTP drain exceeded SHUTDOWN_TIMEOUT_MS; forcing exit",
      );
      deps.exit(1);
      // exit(1) terminates the process in prod, but in tests exit is stubbed
      // — resolve so the outer await doesn't hang the test runner.
      resolve();
    }, timeoutMs);

    try {
      deps.server.close((err) => {
        clearTimer(timer);
        if (timedOut) return; // exit already called by the timer branch
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    } catch (err) {
      clearTimer(timer);
      reject(err as Error);
    }
  });

  try {
    await drain;
  } catch (err) {
    log.error({ err, signal }, "Error draining HTTP server");
  }

  if (timedOut) {
    // exit(1) has been called; don't attempt boss.stop — we're going down.
    return;
  }

  // -- Step 4: stop pg-boss AFTER the HTTP drain. --------------------------
  try {
    const boss = await deps.getBoss();
    if (boss) {
      await boss.stop({ graceful: true });
    }
  } catch (err) {
    log.error(
      { err, signal },
      "Error stopping job queue during shutdown",
    );
  }

  // -- Step 5: clean exit. -------------------------------------------------
  deps.exit(0);
}

/** Narrow helper for the `index.ts` wiring — strips the http.Server type. */
export function asShutdownServer(server: Server): ShutdownServer {
  return server;
}
