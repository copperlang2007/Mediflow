import { initSentry } from "./lib/sentry";
import { logger } from "./lib/logger";
import { assertProdEnvIntegrity } from "./lib/prodEnvGuard";

// L1 security guard: refuse to boot if production-looking credentials
// (live Clerk keys, non-localhost DATABASE_URL, PHI_ENCRYPTION_KEY set)
// are paired with a non-production NODE_ENV. A misconfigured prod deploy
// that ships `NODE_ENV=test` would otherwise silently bypass
// `requireMfa` enforcement and fall back to the dev sentinel PHI key.
// Run BEFORE Sentry init so an env misconfiguration can't even ship a
// crash to the wrong Sentry environment.
assertProdEnvIntegrity(process.env, logger);

// Initialize Sentry before any other module so that errors thrown during
// app/jobs/workers boot are captured. No-op when SENTRY_DSN is unset.
initSentry();

import type { Server } from "node:http";

import app from "./app";
import { getQueue, startWorkers } from "./lib/jobs";
import { captureWorkerError } from "./lib/sentry";
import { markWorkersReady } from "./lib/readiness";
import { shutdown } from "./lib/shutdown";
import { assertAiProviderHipaaCompliant } from "./lib/aiProvider";
import { assertStorageBackendHipaaCompliant } from "./lib/objectStorage";
import { assertEsignProviderHipaaCompliant } from "./lib/esign/factory";
import { assertEsignSigningCredsAreProd } from "./lib/esign/pkiSigner";

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

  // HIPAA guard: uploaded documents (signed PDFs, etc.) routinely embed PHI.
  // Storage is GCS-only (BAA-covered); in production this fails fast unless
  // the private document bucket (PRIVATE_OBJECT_DIR) is configured, so a
  // misconfigured deploy dies at boot rather than on the first upload.
  assertStorageBackendHipaaCompliant();

  // E-sign provider sanity check (and seam for the prod-must-be-docusign
  // guard once the DocuSign implementation lands). Today this only catches
  // a misspelled ESIGN_PROVIDER value.
  assertEsignProviderHipaaCompliant();

  // ESIGN §101(g) guard: in production, the e-sign provider MUST seal
  // completed envelopes with a real org-owned certificate. The ephemeral
  // dev sentinel cert (CN "Mediflow ESign DEV ONLY") is generated only
  // for local + CI and is refused here. Mirrors the medicareId.ts PHI key
  // guard pattern.
  assertEsignSigningCredsAreProd();

  // Operational nudge: if Twilio is configured but the webhook public
  // host pin isn't, log a one-time WARN. Header-based URL reconstruction
  // still works (and is required behind some proxies) but is brittle.
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    !process.env.TWILIO_WEBHOOK_PUBLIC_HOST
  ) {
    logger.warn(
      "TWILIO_ACCOUNT_SID is set but TWILIO_WEBHOOK_PUBLIC_HOST is not; " +
        "inbound SMS signature verification will fall back to Host/X-Forwarded-Proto " +
        "headers. Set TWILIO_WEBHOOK_PUBLIC_HOST (e.g. https://mediflow.app) " +
        "to pin the signed URL to your public origin.",
    );
  }

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
    // Fatal in production AND on Render (RENDER is set on every Render
    // service): the demo blueprint health-checks /api/readyz, and a process
    // that latches workers=not_ready would sit permanently unhealthy —
    // Render never routes to it and never restarts it. Exiting turns a
    // transient blip into a crash-restart-retry loop that self-heals.
    if (process.env.NODE_ENV === "production" || process.env.RENDER) {
      logger.fatal(
        { err },
        "Exiting: worker startup failure is fatal when a platform health-checks readiness",
      );
      process.exit(1);
    }
    // Local dev only: keep iterating without queue infra; readiness will
    // simply stay 503 because `markWorkersReady()` won't be called.
    logger.warn(
      "Continuing without background jobs (local dev); /readyz will report not_ready",
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
