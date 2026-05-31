import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import { logger } from "./lib/logger";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "./middlewares/requireAuth";
import { addSseSubscriber, removeSseSubscriber } from "./lib/sseManager";
import { metricsMiddleware } from "./middlewares/metricsMiddleware";
import {
  metricsRegistry,
  refreshQueueGaugesIfPossible,
} from "./lib/metrics";
import { buildShaHeader } from "./middlewares/buildShaHeader";
import { getBuildInfo } from "./lib/buildInfo";

const app: Express = express();

/**
 * Derive the exact origin that browsers will send.
 * In production this is the app's public domain, set via ALLOWED_ORIGIN.
 *
 * Security policy: if no origin can be resolved, CORS is DENIED (false),
 * not opened. This is intentionally strict — set ALLOWED_ORIGIN (the app's
 * public origin) explicitly.
 */
function resolveAllowedOrigin(): string | false {
  const explicit = process.env.ALLOWED_ORIGIN;
  if (explicit) return explicit;
  logger.warn(
    "CORS: ALLOWED_ORIGIN is not set — cross-origin requests will be denied",
  );
  return false;
}

const allowedOrigin = resolveAllowedOrigin();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Stamp every response with the build SHA so ops can debug-by-curl.
// Registered before routing so even 404s + error responses carry it.
app.use(buildShaHeader);

// Per-request HTTP metrics. Registered EARLY so the response-finish
// listener observes the full request lifecycle (including time spent in
// rate limiters, auth, etc.). The /metrics endpoint itself is excluded
// inside the middleware so Prometheus scrape latency doesn't loop into
// the histogram. See lib/metrics.ts for cardinality discipline.
app.use(metricsMiddleware);

// CORS — locked to exact known origin; never falls back to wildcard
app.use(
  cors({
    credentials: true,
    origin: allowedOrigin
      ? (origin, callback) => {
          if (!origin || origin === allowedOrigin) {
            callback(null, true);
          } else {
            callback(new Error(`CORS: origin ${origin} not allowed`));
          }
        }
      : false,
  }),
);

// Global rate limit: 500 requests / 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Auth endpoints: 20 requests / minute per IP (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again." },
});
app.use("/api/auth", authLimiter);


app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Per-user rate limit: 100 requests / minute, keyed by Clerk userId.
// Applied AFTER clerkMiddleware so getAuth(req) is populated.
// Falls back to IP for unauthenticated requests.
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const { userId } = getAuth(req);
    if (userId) return `user:${userId}`;
    return req.ip ?? "unknown";
  },
  message: { error: "Request rate limit exceeded." },
});
app.use("/api", userLimiter);

// Twilio inbound webhooks — mounted at root so Twilio can reach them without
// API auth middleware. Signature validation is enforced inside the handler.
app.use(webhooksRouter);

/**
 * GET /version — release identity for monitoring probes.
 *
 * Public (same info that X-Build-Sha already leaks on every response).
 * No state checks, no DB hit — meant to be cheap enough to scrape from
 * an external uptime monitor every few seconds without thinking about it.
 */
app.get("/version", (_req: Request, res: Response): void => {
  const build = getBuildInfo();
  res.json({
    version: build.version,
    sha: build.sha,
    builtAt: build.builtAt,
    nodeVersion: build.nodeVersion,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

/**
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Auth: bearer token via `Authorization: Bearer <METRICS_TOKEN>`. In
 * production METRICS_TOKEN MUST be set — without it the endpoint returns
 * 503 (refuse rather than expose). In non-production missing token is
 * permitted to keep local-dev observability frictionless.
 *
 * The handler refreshes the pg-boss queue gauges on each scrape — that's
 * cheaper than polling on a timer and matches Prometheus's pull model.
 */
app.get("/metrics", async (req: Request, res: Response): Promise<void> => {
  const expected = process.env.METRICS_TOKEN?.trim();
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      res
        .status(503)
        .json({ error: "Metrics endpoint not configured (METRICS_TOKEN unset)" });
      return;
    }
    // Non-prod fall-through to ungated access.
  } else {
    const header = req.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (supplied !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  try {
    await refreshQueueGaugesIfPossible();
    const body = await metricsRegistry.metrics();
    res.set("Content-Type", metricsRegistry.contentType);
    res.send(body);
  } catch (err) {
    req.log.error({ err }, "Failed to serialize Prometheus metrics");
    res.status(500).json({ error: "Failed to serialize metrics" });
  }
});

// SSE spec alias: GET /sse/notifications (mirrors /api/notifications/stream)
app.get(
  "/sse/notifications",
  requireAuth,
  requirePermission("notification", "read"),
  (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 25_000);
    addSseSubscriber(authReq.userId, res);
    req.on("close", () => {
      clearInterval(heartbeat);
      removeSseSubscriber(authReq.userId, res);
    });
  },
);

app.use("/api", router);

// Global typed error handler — must be registered last, after all routes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  req.log.error({ err }, "Unhandled error");
  const httpErr = err as { status?: number; statusCode?: number };
  const status = httpErr.status ?? httpErr.statusCode ?? 500;
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal server error";
  res.status(status).json({ error: message });
});

export default app;
