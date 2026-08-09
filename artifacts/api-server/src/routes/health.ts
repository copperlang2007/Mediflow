import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, sql } from "@workspace/db";
import {
  checkWorkerLiveness,
  getReadinessState,
  isReadinessCacheFresh,
  markReadinessOk,
  pingDb,
  type DbCheckResult,
  type WorkerCheckResult,
  type WorkerLivenessSource,
} from "../lib/readiness";
import { peekQueue } from "../lib/jobs";

const router: IRouter = Router();

/** Core table (migration 0000) used by /readyz to prove the app schema is
 *  migrated, not merely that the database accepts connections. */
const SCHEMA_PROBE_TABLE = "users";

/**
 * Liveness probe — process is alive. Always returns 200 (unless the event
 * loop itself is hung, in which case nothing responds anyway).
 *
 * Intentionally does NOT touch the DB or workers: a transient DB blip must
 * not cause Kubernetes/the load balancer to kill the pod, only to pull it
 * out of rotation (which is what `/readyz` is for).
 */
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Readiness probe — process is ready to serve traffic. Returns 200 only if:
 *  - background workers finished startup (see `markWorkersReady()`),
 *  - background workers are still LIVE — pg-boss reports at least one worker
 *    loop that is not stopped (see `checkWorkerLiveness()`). This catches the
 *    case where every worker dies after boot: the boot-time flag stays `true`
 *    but the node would silently run no background jobs.
 *  - the database responds within ~500ms to a probe that also proves the
 *    app schema exists (`SELECT 1 FROM users LIMIT 0`) — a bare `SELECT 1`
 *    passes against a reachable-but-unmigrated database, reporting ready
 *    while every real endpoint 500s on missing tables.
 *
 * Successful results are cached briefly (~2s) to avoid hammering the DB from
 * per-pod probes. Failures are never cached so recovery is detected fast.
 */
router.get("/readyz", async (_req, res) => {
  const { workersReady } = getReadinessState();

  // Fast path: workers never finished boot startup — no point checking
  // anything else.
  if (!workersReady) {
    res.status(503).json({
      status: "unhealthy",
      checks: { db: "unknown", workers: "not_ready" },
    });
    return;
  }

  // Cached OK path: within 2s of the last successful check, skip the DB ping
  // and the worker-liveness check.
  if (isReadinessCacheFresh()) {
    res.status(200).json({
      status: "ok",
      checks: { db: "ok", workers: "ok" },
    });
    return;
  }

  // Live worker-liveness check: boot-time success is not enough — verify the
  // pg-boss worker loops are still running.
  const workerLiveness: WorkerCheckResult = await checkWorkerLiveness(
    async (): Promise<WorkerLivenessSource | null> => peekQueue(),
  );
  if (workerLiveness !== "ok") {
    res.status(503).json({
      status: "unhealthy",
      checks: { db: "unknown", workers: workerLiveness },
    });
    return;
  }

  // LIMIT 0 keeps the probe free (no rows scanned) while still failing with
  // 42P01 when the probe table is absent. DELIBERATE coupling: renaming the
  // probe table without updating SCHEMA_PROBE_TABLE flips readiness to 503
  // everywhere — that rename is a migration-level event whose checklist
  // includes this constant (single place to update).
  const dbCheck: DbCheckResult = await pingDb(() =>
    db.execute(sql`SELECT 1 FROM ${sql.identifier(SCHEMA_PROBE_TABLE)} LIMIT 0`),
  );
  if (dbCheck !== "ok") {
    res.status(503).json({
      status: "unhealthy",
      checks: { db: dbCheck, workers: "ok" },
    });
    return;
  }

  markReadinessOk();
  res.status(200).json({
    status: "ok",
    checks: { db: "ok", workers: "ok" },
  });
});

export default router;
