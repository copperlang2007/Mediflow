/**
 * Agent "Ready to Sell" readiness board API (Clerk-authed admin surface).
 *
 * The admin-facing inverse of the inbound router: instead of "who can sell THIS
 * lead", it reports — for every agent in the org — what makes them ready to
 * sell and what is blocking them, so admins can drive onboarding completion and
 * grow the routable pool. Read model lives in lib/agents/readiness.ts (which
 * mirrors lib/leadQueue/readyToSell.ts's gate semantics).
 *
 *   GET /api/agents/readiness?certificationYear=  — org-wide readiness board
 *   GET /api/agents/credential-expiry?withinDays=  — expiring-soon early warning
 *
 * Kept in its own route file (not routes/queue.ts) — this is an onboarding /
 * roster oversight surface gated on `agent:read`, not part of the routing hot
 * path.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { getOrgReadiness } from "../lib/agents/readiness";
import { getExpiringCredentials } from "../lib/agents/credentialExpiry";

const router: IRouter = Router();

const QuerySchema = z.object({
  certificationYear: z.coerce.number().int().min(2000).max(2100).optional(),
});

const ExpirySchema = z.object({
  withinDays: z.coerce.number().int().min(1).max(365).default(60),
});

router.get(
  "/agents/readiness",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }

    const now = new Date();
    const overview = await getOrgReadiness(
      authReq.orgId,
      parsed.data.certificationYear,
      now,
    );

    res.json({
      data: overview.agents,
      readyCount: overview.readyCount,
      totalCount: overview.totalCount,
      certificationYear: overview.certificationYear,
      asOf: overview.asOf,
    });
  },
);

/**
 * Forward-looking complement to the readiness board: which credentials are
 * about to expire (future, but within `withinDays`) for the org's active
 * agents, so admins act before the lapse silently drops the agent from the
 * routable pool (the RTS eligibility gate already excludes expired creds).
 */
router.get(
  "/agents/credential-expiry",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = ExpirySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }

    const now = new Date();
    const result = await getExpiringCredentials(
      authReq.orgId,
      parsed.data.withinDays,
      now,
    );

    res.json({
      data: result.data,
      withinDays: result.withinDays,
      asOf: result.asOf,
      counts: result.counts,
    });
  },
);

export default router;
