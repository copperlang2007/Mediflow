/**
 * Tracks readiness state of the API server for Kubernetes-style readiness
 * probes (`/readyz`).
 *
 * Two-phase model:
 *  - Liveness (`/healthz`): the process is alive. Cheap, no I/O.
 *  - Readiness (`/readyz`): the process is ready to serve traffic, meaning
 *    background workers are LIVE AND the database is reachable.
 *
 * We DO NOT tie liveness to the DB ping — that would cause thundering-herd
 * restart loops if the DB has a transient blip. Instead the load balancer
 * pulls a pod out of rotation via `/readyz` and the process keeps running.
 *
 * Worker liveness:
 *  `markWorkersReady()` records that `startWorkers()` succeeded at boot, but
 *  that boot-time flag is NOT sufficient — if every pg-boss worker dies after
 *  boot the flag stays `true` forever and the node keeps taking traffic while
 *  running no background jobs. `/readyz` therefore also queries pg-boss's live
 *  `getWipData()` snapshot (see `checkWorkerLiveness`): each `boss.work()`
 *  call registers a worker whose `state` transitions created → active →
 *  stopping → stopped. Readiness requires at least one worker that is NOT
 *  stopped/stopping. If pg-boss itself has crashed (no instance, throws) we
 *  also treat workers as dead.
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
 *
 * NOTE: this only reflects boot-time success. Live worker health is checked
 * separately via `checkWorkerLiveness()`.
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

// ---- Live worker liveness --------------------------------------------------

export type WorkerCheckResult = "ok" | "dead" | "unknown";

/**
 * Minimal shape of the bits of a pg-boss instance we need for the liveness
 * check. Injected so the route can pass the real boss and tests can pass a
 * stub without spinning up pg-boss.
 */
export interface WorkerLivenessSource {
  /**
   * pg-boss v12 `getWipData()` — a synchronous in-memory snapshot of every
   * registered worker loop and its current lifecycle state.
   */
  getWipData(options?: { includeInternal?: boolean }): Array<{
    name: string;
    state: "created" | "active" | "stopping" | "stopped";
  }>;
}

/**
 * Returns whether background workers are currently LIVE, based on pg-boss's
 * live work-in-progress snapshot rather than the boot-time `workersReady`
 * flag. Never throws.
 *
 * - `"ok"`     — at least one worker is registered and not stopped/stopping.
 * - `"dead"`   — workers were registered but every one is stopped/stopping,
 *                OR pg-boss reports zero workers (every `work()` loop gone).
 * - `"unknown"`— pg-boss is unavailable (instance missing / threw). The
 *                caller decides how to treat this; `/readyz` treats it as a
 *                failure so a crashed queue does not pass readiness.
 *
 * `getBoss` is async because the real `getQueue()` lazily starts pg-boss.
 */
export async function checkWorkerLiveness(
  getBoss: () => Promise<WorkerLivenessSource | null>,
): Promise<WorkerCheckResult> {
  let boss: WorkerLivenessSource | null;
  try {
    boss = await getBoss();
  } catch {
    return "unknown";
  }
  if (!boss) return "unknown";

  let wip: Array<{ name: string; state: string }>;
  try {
    wip = boss.getWipData();
  } catch {
    return "unknown";
  }

  if (wip.length === 0) {
    // Workers were registered at boot (`markWorkersReady`) but pg-boss now
    // reports no worker loops at all — the queue lost every worker.
    return "dead";
  }

  const anyLive = wip.some(
    (w) => w.state === "created" || w.state === "active",
  );
  return anyLive ? "ok" : "dead";
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
