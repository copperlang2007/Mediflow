import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, sql } from "@workspace/db";
import {
  getReadinessState,
  isReadinessCacheFresh,
  markReadinessOk,
  pingDb,
  type DbCheckResult,
} from "../lib/readiness";

const router: IRouter = Router();

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
 *  - the database responds to `SELECT 1` within ~500ms.
 *
 * Successful results are cached briefly (~2s) to avoid hammering the DB from
 * per-pod probes. Failures are never cached so recovery is detected fast.
 */
router.get("/readyz", async (_req, res) => {
  const { workersReady } = getReadinessState();
  const workersCheck: "ok" | "not_ready" = workersReady ? "ok" : "not_ready";

  // Fast path: workers haven't started — no point pinging DB.
  if (!workersReady) {
    res.status(503).json({
      status: "unhealthy",
      checks: { db: "unknown", workers: workersCheck },
    });
    return;
  }

  // Cached OK path: within 2s of the last successful check, skip the DB ping.
  if (isReadinessCacheFresh()) {
    res.status(200).json({
      status: "ok",
      checks: { db: "ok", workers: "ok" },
    });
    return;
  }

  const dbCheck: DbCheckResult = await pingDb(() => db.execute(sql`SELECT 1`));
  if (dbCheck !== "ok") {
    res.status(503).json({
      status: "unhealthy",
      checks: { db: dbCheck, workers: workersCheck },
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
