import { initSentry } from "./lib/sentry";

// Initialize Sentry before any other module so that errors thrown during
// app/jobs/workers boot are captured. No-op when SENTRY_DSN is unset.
initSentry();

import type { Server } from "node:http";

import app from "./app";
import { logger } from "./lib/logger";
import { getQueue, startWorkers } from "./lib/jobs";
import { captureWorkerError } from "./lib/sentry";
import { markWorkersReady } from "./lib/readiness";
import { shutdown } from "./lib/shutdown";
import { assertAiProviderHipaaCompliant } from "./lib/aiProvider";

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

// Hoisted so SIGTERM/SIGINT handlers (registered below) can close the
// listening server during graceful shutdown. Stays `let` rather than a
// module-level mutable export — only this file mutates it.
let server: Server | undefined;

async function bootstrap(): Promise<void> {
  // HIPAA guard: PHI flows to the AI provider in system prompts. In
  // production the provider MUST be Azure OpenAI (the only BAA-covered
  // path). Fail fast and visibly here so a misconfigured prod deploy
  // dies at boot rather than leaking PHI on the first patient
  // interaction. Mirrors the PHI_ENCRYPTION_KEY boot check (PR #64).
  assertAiProviderHipaaCompliant();

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

  server = app.listen(port, (err) => {
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

// Graceful shutdown wiring. The actual sequence lives in `./lib/shutdown` so
// it can be unit-tested without real signals or sockets.
//
// `getBoss` is lazy because pg-boss may have failed to start (degraded mode
// in non-prod). In that case `getQueue()` would throw and we want to skip
// the boss-stop step rather than block exit.
const onSignal = (signal: string): void => {
  if (!server) {
    // bootstrap hasn't finished listening yet — nothing to drain.
    logger.info({ signal }, "Shutdown signal received before server started");
    process.exit(0);
    return;
  }
  shutdown(signal, {
    server,
    getBoss: async () => {
      try {
        return await getQueue();
      } catch {
        return null;
      }
    },
    exit: (code) => process.exit(code),
  }).catch((err) => {
    logger.error({ err, signal }, "Unhandled error in shutdown handler");
    process.exit(1);
  });
};

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
