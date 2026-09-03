import fs from "node:fs";
import path from "node:path";
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
import stripeWebhookRouter from "./routes/stripeWebhook";
import dialerEventsRouter from "./routes/dialerEvents";
import queuePublicRouter from "./routes/queuePublic";
import { logger } from "./lib/logger";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "./middlewares/requireAuth";
import { isDemoMode } from "./lib/demoMode";
import { addSseSubscriber, removeSseSubscriber } from "./lib/sseManager";
import { metricsMiddleware } from "./middlewares/metricsMiddleware";
import {
  metricsRegistry,
  refreshQueueGaugesIfPossible,
} from "./lib/metrics";
import { buildShaHeader } from "./middlewares/buildShaHeader";
import { getBuildInfo } from "./lib/buildInfo";

const app: Express = express();

function resolveWebStaticDir(): string | undefined {
  const explicit = process.env.WEB_STATIC_DIR?.trim();
  const candidates = [
    explicit,
    // Render/root start command: repo root is the process cwd.
    path.resolve(process.cwd(), "artifacts/web-app/dist/public"),
    // Package-local start command: cwd is artifacts/api-server.
    path.resolve(process.cwd(), "../web-app/dist/public"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
}


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

// Capture the raw request body so signed webhooks (the dialer event
// receiver) can recompute their HMAC over the exact bytes received. The
// hook runs for every JSON request but only stashes a Buffer — negligible
// overhead, and it keeps signature verification independent of JSON
// re-serialization (key ordering / whitespace would otherwise break it).
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

const webStaticDir = resolveWebStaticDir();

if (webStaticDir) {
  logger.info({ webStaticDir }, "Serving bundled web app");
  app.use(
    express.static(webStaticDir, {
      index: false,
      maxAge: "1y",
      immutable: true,
    }),
  );

  // SPA fallback for client-side routes on single-service hosts (Render,
  // Fly, Railway). Register before Clerk's API middleware so the shell can
  // render even when API credentials are still being wired. Keep API/ops
  // endpoints out so failed API paths surface as API failures, not index.html.
  app.get(/^(?!\/api(?:\/|$)|\/metrics$|\/version$).*/, (_req, res) => {
    res.sendFile(path.join(webStaticDir, "index.html"));
  });
} else {
  logger.warn(
    "Web static bundle not found; API-only mode. Run `pnpm --filter @workspace/web-app run build` or set WEB_STATIC_DIR.",
  );
}

// Demo mode bypasses Clerk entirely (requireAuth injects the seeded demo
// user). Mounting clerkMiddleware without a secret key throws per-request, so
// skip it. isDemoMode() is a hard no-op under NODE_ENV=production.
if (!isDemoMode()) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

// Per-user rate limit: 100 requests / minute, keyed by Clerk userId.
// Applied AFTER clerkMiddleware so getAuth(req) is populated.
// Falls back to IP for unauthenticated requests.
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Demo mode keys by IP (no Clerk userId), so multiple walkthrough viewers
  // behind one office/VPN egress share a budget — raise it so they aren't
  // throttled. Real deploys key by userId and keep the tighter per-user cap.
  max: isDemoMode() ? 2000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    // In demo mode clerkMiddleware is not mounted, so getAuth() is unavailable
    // — key by IP. Real deploys key by Clerk userId.
    if (!isDemoMode()) {
      const { userId } = getAuth(req);
      if (userId) return `user:${userId}`;
    }

    // FAIL CLOSED: require valid IP from reverse proxy
    const ip = req.ip;
    if (!ip) {
      logger.error(
        { 
          headers: req.headers,
          xForwardedFor: req.headers["x-forwarded-for"],
        },
        "RATE LIMIT: Missing IP address — verify X-Forwarded-For or trusted proxy config"
      );
      // Throw error so this request gets a 429 + ops alert
      throw new Error("Rate limit key generation failed: no IP");
    }
    return ip;
  },
  message: { error: "Request rate limit exceeded." },
});
app.use("/api", userLimiter);

// Twilio inbound webhooks — mounted at root so Twilio can reach them without
// API auth middleware. Signature validation is enforced inside the handler.
app.use(webhooksRouter);

// Stripe billing webhooks — mounted at root alongside the Twilio receiver and
// for the same reason: Stripe has no Clerk session. Trust comes from the
// `stripe-signature` HMAC verified against STRIPE_WEBHOOK_SECRET inside the
// handler, over the raw bytes captured by the express.json verify hook above.
app.use(stripeWebhookRouter);

// masterBRIDGE dialer event receiver (spec §6). Path lives under /api/dialer/v1
// to match the contract's callbackUrl, but is mounted HERE — above the
// Clerk-guarded `/api` router below — because trust is established by the
// X-MB-Signature HMAC, not a Clerk session.
app.use(dialerEventsRouter);

// Public inbound-lead routing for GoHighLevel / the Atlas proxy. Mounted here
// (path `/api/queue/v1/route-inbound`) for the same reason as the dialer
// receiver: external callers authenticate with an X-MB-Signature HMAC, not a
// Clerk session. See routes/queuePublic.ts.
app.use(queuePublicRouter);

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
    // Race with 5s timeout to prevent Prometheus scrape hangs
    const metrics = await Promise.race([
      (async () => {
        await refreshQueueGaugesIfPossible();
        return await metricsRegistry.metrics();
      })(),
      new Promise<string>((_, reject) => 
        setTimeout(() => reject(new Error("Metrics scrape timeout")), 5000)
      ),
    ]);
    
    res.set("Content-Type", metricsRegistry.contentType);
    res.send(metrics);
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
    
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      removeSseSubscriber(authReq.userId, res);
      try { res.end(); } catch { /* already closed */ }
    };
    
    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": heartbeat\n\n");
      } catch (err) {
        req.log.debug({ err }, "SSE write failed — closing connection");
        cleanup();
      }
    }, 25_000);
    
    addSseSubscriber(authReq.userId, res);
    req.on("close", cleanup);
    res.on("error", (err) => {
      req.log.warn({ err }, "SSE response error");
      cleanup();
    });
  },
);

app.use("/api", router);

// Global typed error handler — must be registered last, after all routes.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  // Generate a simple error ID from timestamp + random bytes
  const errorId = `err_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  
  // ALWAYS log full details server-side for debugging
  req.log.error(
    { 
      err, 
      errorId, 
      path: req.path, 
      method: req.method,
      userId: (req as any).auth?.userId,
    },
    "Unhandled error"
  );

  const httpErr = err as { status?: number; statusCode?: number; message?: string } | null;
  const status = httpErr?.status ?? httpErr?.statusCode ?? 500;
  
  // In production: NEVER expose implementation details
  if (process.env.NODE_ENV === "production") {
    res.status(status).json({ 
      error: "An error occurred. Please reference ID: " + errorId,
      errorId,
    });
  } else {
    // Dev/staging: show the actual message for debugging
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message, errorId });
  }
});

export default app;