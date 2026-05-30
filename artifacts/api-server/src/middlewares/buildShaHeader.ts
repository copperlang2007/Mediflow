/**
 * Sets `X-Build-Sha: <sha>` on every response so ops can debug-by-curl
 * to confirm which deploy is actually serving traffic. Same value Sentry
 * uses as the `release` identifier — so a stack trace and a curl probe
 * tie to the same artifact.
 *
 * Sub-microsecond overhead (one header set). No allocations per request
 * beyond what Express already does.
 *
 * Registered early in `app.ts` so even error responses (404, 500) carry
 * the header.
 */
import type { Request, Response, NextFunction } from "express";
import { getBuildInfo } from "../lib/buildInfo";

// Resolved once at middleware-factory time. The build info is fixed for
// the lifetime of the process — reading on each request would be wasted
// CPU.
const sha = getBuildInfo().sha;

export function buildShaHeader(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Build-Sha", sha);
  next();
}
