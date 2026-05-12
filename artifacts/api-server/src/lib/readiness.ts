/**
 * Tracks readiness state of the API server for Kubernetes-style readiness
 * probes (`/readyz`).
 *
 * Two-phase model:
 *  - Liveness (`/healthz`): the process is alive. Cheap, no I/O.
 *  - Readiness (`/readyz`): the process is ready to serve traffic, meaning
 *    background workers have completed startup AND the database is reachable.
 *
 * We DO NOT tie liveness to the DB ping — that would cause thundering-herd
 * restart loops if the DB has a transient blip. Instead the load balancer
 * pulls a pod out of rotation via `/readyz` and the process keeps running.
 */

export interface ReadinessState {
  workersReady: boolean;
}

const state: ReadinessState = {
  workersReady: false,
};

/**
 * Called by `startWorkers()` in `index.ts` once all background workers have
 * registered with pg-boss. Until this fires, `/readyz` returns 503.
 */
export function markWorkersReady(): void {
  state.workersReady = true;
}

export function getReadinessState(): Readonly<ReadinessState> {
  return state;
}

/**
 * Test-only: reset readiness state between tests. Not exported via any
 * package boundary; intended for use from the integration test suite.
 */
export function __resetReadinessForTests(): void {
  state.workersReady = false;
  cachedOkUntil = 0;
}

// ---- DB ping with short timeout + brief OK cache ---------------------------

const DB_PING_TIMEOUT_MS = 500;
const OK_CACHE_TTL_MS = 2_000;

let cachedOkUntil = 0;

export type DbCheckResult = "ok" | "failed";

/**
 * Pings the database with a short timeout. Returns "ok" or "failed".
 * Never throws.
 *
 * The query runner is injected so tests can stub a failure without mocking
 * `@workspace/db`. In production we pass the real drizzle `db`.
 */
export async function pingDb(
  runQuery: () => Promise<unknown>,
  timeoutMs: number = DB_PING_TIMEOUT_MS,
): Promise<DbCheckResult> {
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db ping timeout")), timeoutMs);
    });
    try {
      await Promise.race([runQuery(), timeout]);
      return "ok";
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return "failed";
  }
}

/**
 * Returns true if a previous successful readiness check is still within the
 * cache window. We cache OK results (to avoid pounding the DB from per-pod
 * probes) but never cache failures — we want fast recovery detection.
 */
export function isReadinessCacheFresh(now: number = Date.now()): boolean {
  return now < cachedOkUntil;
}

export function markReadinessOk(now: number = Date.now()): void {
  cachedOkUntil = now + OK_CACHE_TTL_MS;
}
