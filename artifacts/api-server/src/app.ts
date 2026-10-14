import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { getAuth, identityMiddleware } from "./lib/auth/identity";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import voiceWebhooksRouter from "./routes/voiceWebhooks";
import stripeWebhookRouter from "./routes/stripeWebhook";
import dialerEventsRouter from "./routes/dialerEvents";
import queuePublicRouter from "./routes/queuePublic";
import unsubscribeRouter from "./routes/unsubscribe";
import enrollhereWebhookRouter from "./routes/enrollhereWebhook";
import campaignsPublicRouter from "./routes/campaignsPublic";
import { logger } from "./lib/logger";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "./middlewares/requireAuth";
import { isDemoMode } from "./lib/demoMode";
import { addSseSubscriber, removeSseSubscriber } from "./lib/sseManager";
import { metricsMiddleware } from "./middlewares/metricsMiddleware";
import { auditMiddleware } from "./middlewares/auditMiddleware";
import {
  metricsRegistry,
  refreshQueueGaugesIfPossible,
} from "./lib/metrics";
import { buildShaHeader } from "./middlewares/buildShaHeader";
import { getBuildInfo } from "./lib/buildInfo";

const app: Express = express();

// Cloud Run places one trusted proxy in front of the container. Resolve the
// client IP from the proxy's X-Forwarded-For header for rate limiting, rather
// than treating every visitor as the same Cloud Run hop.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

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
function resolveAllowedOrigins(): Set<string> {
  const origins = (process.env.ALLOWED_ORIGIN ?? "")
    .split("|")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    logger.warn(
      "CORS: ALLOWED_ORIGIN is not set — cross-origin requests will be denied",
    );
  }
  return new Set(origins);
}

const allowedOrigins = resolveAllowedOrigins();

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

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      "script-src": ["'self'"],
      "connect-src": [
        "'self'",
        // Sign-in (Google Cloud Identity Platform, ADR 0006): password,
        // second-factor and token-refresh calls from the browser SDK.
        "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
        // Twilio Voice SDK signalling (browser calling): HTTPS + secure WebSocket.
        "https://*.twilio.com", "wss://*.twilio.com",
        // Call recordings upload straight to Cloud Storage with a signed URL.
        "https://storage.googleapis.com",
      ],
      // The Voice SDK plays its ring / disconnect tones from Twilio's CDN.
      "media-src": ["'self'", "https://sdk.twilio.com", "https://storage.googleapis.com", "data:", "blob:"],
      "frame-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "worker-src": ["'self'", "blob:"],
    },
  },
}));

// Stamp every response with the build SHA so ops can debug-by-curl.
// Registered before routing so even 404s + error responses carry it.
app.use(buildShaHeader);

// Per-request HTTP metrics. Registered EARLY so the response-finish
// listener observes the full request lifecycle (including time spent in
// rate limiters, auth, etc.). The /metrics endpoint itself is excluded
// inside the middleware so Prometheus scrape latency doesn't loop into
// the histogram. See lib/metrics.ts for cardinality discipline.
app.use(metricsMiddleware);

// CORS applies to API and SSE responses. Public HTML and JavaScript are
// served on the request's own host; applying the configured API origin to
// those files breaks the app when Cloud Run exposes another service URL.
const apiCors = cors({
  credentials: true,
  origin: allowedOrigins.size > 0
    ? (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: origin ${origin} not allowed`));
        }
      }
    : false,
});
app.use("/api", apiCors);
app.use("/sse/notifications", apiCors);

// Global rate limit: 500 requests / 15 minutes per IP
// Twilio Voice webhooks come from Twilio's shared egress IPs, not from users, so
// the per-IP budgets below would throttle real call events (a 429 makes Twilio
// drop or retry the callback). They are exempt here; they keep their own
// dedicated limiter (routes/voiceWebhooks.ts) and X-Twilio-Signature check.
// originalUrl, not path: under `app.use("/api", …)` req.path has "/api" stripped.
// EXACT paths only — an unknown subpath such as /voice-fake stays rate limited.
const VOICE_WEBHOOK_PATHS: ReadonlySet<string> = new Set([
  "/api/webhooks/twilio/voice",
  "/api/webhooks/twilio/voice-status",
  "/api/webhooks/twilio/voice-notice",
]);
const isVoiceWebhook = (req: Request): boolean =>
  VOICE_WEBHOOK_PATHS.has(req.originalUrl.split("?")[0]!);

const globalLimiter = rateLimit({
  skip: isVoiceWebhook,
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false }, // Express uses trusted X-Forwarded-For.
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Auth endpoints: 20 requests / minute per IP (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false }, // Express uses trusted X-Forwarded-For.
  message: { error: "Too many authentication attempts, please try again." },
});
app.use("/api/auth", authLimiter);

// Invitation lookup and acceptance are reachable without a agencyBRIDGE account —
// that is the point of them — so they sit in the same brute-force bucket as
// /api/auth rather than the general per-user one. The token itself is 256 bits
// of randomness and is not guessable, but these two endpoints are the only
// unauthenticated writes into the tenancy model and should be as boring to
// probe as sign-in is.
app.use("/api/invitations/lookup", authLimiter);
app.use("/api/invitations/accept", authLimiter);


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
  // Only content-hashed bundles are immutable. Public files such as the boot
  // diagnostic and logo retain stable URLs and must refresh on deployment.
  app.use("/assets", express.static(path.join(webStaticDir, "assets"), {
    index: false,
    maxAge: "1y",
    immutable: true,
  }));
  app.use(express.static(webStaticDir, {
    index: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      // index.html must never be cached: a stale copy references hashed
      // bundles removed by later deploys, breaking the SPA on next load.
      if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith("/index.html")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
      }
    },
  }));

  // A missing hashed asset must surface as a 404 so browsers holding a stale
  // index.html (referencing a bundle from a prior deploy) fail loudly instead
  // of executing the SPA shell as JavaScript.
  app.use("/assets", (_req, res) => {
    res.status(404).type("text/plain").send("Not Found");
  });

  // SPA fallback for client-side routes on single-service hosts (Render,
  // Fly, Railway). Register before the sign-in middleware so the shell can
  // render even when API credentials are still being wired. Keep API/ops
  // endpoints and /assets out so failed API/asset paths surface as their own
  // failures rather than index.html.
  app.get(/^(?!\/api(?:\/|$)|\/assets(?:\/|$)|\/metrics$|\/version$).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(path.join(webStaticDir, "index.html"));
  });
} else {
  logger.warn(
    "Web static bundle not found; API-only mode. Run `pnpm --filter @workspace/web-app run build` or set WEB_STATIC_DIR.",
  );
}

// Verify the sign-in token (Identity Platform ID token) once per request; see
// lib/auth/identity.ts. Demo mode has no sign-in (requireAuth injects the
// seeded demo user); isDemoMode() is a hard no-op under NODE_ENV=production.
if (!isDemoMode()) app.use(identityMiddleware());

// Per-user rate limit: 100 requests / minute, keyed by the signed-in identity.
// Applied AFTER identityMiddleware so getAuth(req) is populated.
// Falls back to IP for unauthenticated requests.
const userLimiter = rateLimit({
  skip: isVoiceWebhook,
  windowMs: 60 * 1000,
  // Demo mode keys by IP (no signed-in identity), so multiple walkthrough viewers
  // behind one office/VPN egress share a budget — raise it so they aren't
  // throttled. Real deploys key by userId and keep the tighter per-user cap.
  max: isDemoMode() ? 2000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    // Demo mode keys by IP; real deploys key by the signed-in identity.
    if (!isDemoMode()) {
      const { subject } = getAuth(req);
      if (subject) return `user:${subject}`;
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

// Twilio Voice (native browser calling): TwiML webhook + status callbacks.
// Same posture as the SMS receiver above — signature-verified, no sign-in.
app.use(voiceWebhooksRouter);

// Stripe billing webhooks — mounted at root alongside the Twilio receiver and
// for the same reason: Stripe has no sign-in session. Trust comes from the
// `stripe-signature` HMAC verified against STRIPE_WEBHOOK_SECRET inside the
// handler, over the raw bytes captured by the express.json verify hook above.
app.use(stripeWebhookRouter);

// masterBRIDGE dialer event receiver (spec §6). Path lives under /api/dialer/v1
// to match the contract's callbackUrl, but is mounted HERE — above the
// sign-in-guarded `/api` router below — because trust is established by the
// X-MB-Signature HMAC, not a sign-in session.
app.use(dialerEventsRouter);

// Public inbound-lead routing for GoHighLevel / the Atlas proxy. Mounted here
// (path `/api/queue/v1/route-inbound`) for the same reason as the dialer
// receiver: external callers authenticate with an X-MB-Signature HMAC, not a
// sign-in session. See routes/queuePublic.ts.
app.use(queuePublicRouter);

// EnrollHere inbound call/contact webhook. Same posture: mounted above the
// sign-in-guarded `/api` router, trust from a per-tenant shared secret or
// X-MB-Signature HMAC. See routes/enrollhereWebhook.ts.
app.use(enrollhereWebhookRouter);

// Omnichannel campaigns: Resend (svix-signed) / Twilio (X-Twilio-Signature)
// delivery webhooks. Same posture as the receivers above: no sign-in session,
// trust from a signature. Campaign email unsubscribes go through the shared
// endpoint below. See routes/campaignsPublic.ts.
app.use(campaignsPublicRouter);

// Public email unsubscribe (CAN-SPAM opt-out). Trust comes from the signed
// token in the link, not a sign-in session. See routes/unsubscribe.ts.
app.use(unsubscribeRouter);

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

// Record cross-agency read attempts, including routes without their own read audit.
app.use("/api", auditMiddleware("org", "read", { includeReads: true, viewOnlyReads: true }));
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