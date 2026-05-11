import type { Request, Response, NextFunction } from "express";

/**
 * Dev console gate.
 *
 * The dev console (schema browser, env viewer, etc.) is mounted behind this
 * middleware so that the routes literally do not exist on the wire unless
 * the operator opts in by setting ENABLE_DEV_CONSOLE=true.
 *
 * We return 404 (not 403) when disabled so that probing the URLs from
 * outside is indistinguishable from a route that was never registered.
 */
export function devOnly(req: Request, res: Response, next: NextFunction) {
  if (process.env.ENABLE_DEV_CONSOLE !== "true") {
    res.status(404).json({ error: "Not Found" });
    return;
  }
  next();
}
