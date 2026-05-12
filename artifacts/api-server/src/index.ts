import { initSentry } from "./lib/sentry";

// Initialize Sentry before any other module so that errors thrown during
// app/jobs/workers boot are captured. No-op when SENTRY_DSN is unset.
initSentry();

import app from "./app";
import { logger } from "./lib/logger";
import { getQueue, startWorkers } from "./lib/jobs";
import { captureWorkerError } from "./lib/sentry";
import { markWorkersReady } from "./lib/readiness";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function bootstrap(): Promise<void> {
  // Start pg-boss job queue and register workers.
  //
  // Policy: in production we treat worker-start failure as FATAL. The
  // previous "log and continue" path was the root cause of the readiness
  // gap this endpoint split fixes: a pod with broken workers would silently
  // accept traffic and never run scheduled jobs.
  //
  // In non-production we keep degraded mode so local dev iteration isn't
  // blocked by transient infra issues — readiness will simply stay 503
  // because `markWorkersReady()` won't be called.
  try {
    await getQueue();
    await startWorkers();
    markWorkersReady();
  } catch (err) {
    logger.error({ err }, "Failed to start job queue");
    captureWorkerError(err, { worker: "bootstrap", phase: "startup" });
    if (process.env.NODE_ENV === "production") {
      logger.fatal(
        { err },
        "Exiting: worker startup failure is fatal in production",
      );
      process.exit(1);
    }
    logger.warn(
      "Continuing without background jobs (non-production); /readyz will report not_ready",
    );
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, "Bootstrap failed");
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Shutdown signal received");
  try {
    const { getQueue: q } = await import("./lib/jobs");
    const boss = await q();
    await boss.stop({ graceful: true });
  } catch (err) {
    logger.error({ err, signal }, "Error stopping job queue during shutdown");
    captureWorkerError(err, { worker: "bootstrap", phase: "shutdown", signal });
  }
  process.exit(0);
};

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
