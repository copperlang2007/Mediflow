import app from "./app";
import { logger } from "./lib/logger";
import { getQueue, startWorkers } from "./lib/jobs";

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
  // Start pg-boss job queue and register workers
  try {
    await getQueue();
    await startWorkers();
  } catch (err) {
    logger.error({ err }, "Failed to start job queue — continuing without background jobs");
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
  } catch (_) {
    // ignore
  }
  process.exit(0);
};

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
