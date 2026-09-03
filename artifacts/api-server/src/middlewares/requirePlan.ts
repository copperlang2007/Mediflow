/**
 * Plan-enforcement middleware.
 *
 * Sits after `requireAuth` (which establishes `orgId`) and before the handler.
 * Answers a different question than `requirePermission`: that one asks "is this
 * role allowed to do this?", this one asks "has this agency paid for it?".
 *
 * Both must pass. Keeping them separate means an entitlement change can never
 * quietly widen an RBAC rule, or the reverse.
 */
import { type Request, type Response, type NextFunction } from "express";

import {
  requireCapacity,
  requireFeature,
  PlanLimitError,
  planLimitResponse,
} from "../lib/billing/entitlements";
import type { PlanFeature } from "../lib/billing/plans";
import { type AuthenticatedRequest } from "./requireAuth";
import { logger } from "../lib/logger";

/**
 * Fails a request that would take the org past its record limit.
 * Responds 402 Payment Required with the limit, the current count, and the
 * tier that would lift it — enough for the UI to render an upgrade prompt
 * without a second call.
 */
export function enforceCapacity(resource: "agents" | "contacts") {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    try {
      await requireCapacity(authReq.orgId, resource);
      next();
    } catch (err) {
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json(planLimitResponse(err));
        return;
      }
      // An entitlement lookup that fails for an unrelated reason (a DB blip)
      // must not become a silent paywall bypass — surface it as a 500.
      logger.error({ err, resource }, "Capacity check failed");
      next(err);
    }
  };
}

/** Fails a request for a feature the org's tier does not include. */
export function enforceFeature(feature: PlanFeature) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    try {
      await requireFeature(authReq.orgId, feature);
      next();
    } catch (err) {
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json(planLimitResponse(err));
        return;
      }
      logger.error({ err, feature }, "Feature entitlement check failed");
      next(err);
    }
  };
}
