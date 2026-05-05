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

const app: Express = express();

/**
 * Derive the exact origin that browsers will send.
 * In production this is the app's public domain; in dev it's the Replit proxy.
 *
 * Security policy: if no origin can be resolved, CORS is DENIED (false),
 * not opened. This is intentionally strict — set ALLOWED_ORIGIN or ensure
 * REPLIT_DEV_DOMAIN is present in the environment.
 */
function resolveAllowedOrigin(): string | false {
  const explicit = process.env.ALLOWED_ORIGIN;
  if (explicit) return explicit;
  const replDomain = process.env.REPLIT_DEV_DOMAIN;
  if (replDomain) return `https://${replDomain}`;
  logger.warn(
    "CORS: neither ALLOWED_ORIGIN nor REPLIT_DEV_DOMAIN is set — cross-origin requests will be denied",
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
