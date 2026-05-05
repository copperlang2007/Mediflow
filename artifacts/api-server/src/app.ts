import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import { logger } from "./lib/logger";

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

// Authenticated users: 100 requests / minute per IP
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.headers.authorization && !req.cookies?.["__session"],
  message: { error: "Request rate limit exceeded." },
});
app.use("/api", userLimiter);

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

// Twilio inbound webhooks — mounted at root (not under /api) so Twilio can
// reach them without API auth middleware. Signature validation is enforced
// inside the handler itself.
app.use(webhooksRouter);

app.use("/api", router);

export default app;
