/**
 * Agent activity leaderboard / scorecard API (Clerk-authed admin surface).
 *
 * Ranks the org's active agents by inbound-routing activity over a rolling
 * window — inbounds routed, callbacks resolved, current open-lead load, and the
 * ready-to-sell flag. Read model lives in lib/agents/leaderboard.ts.
 *
 *   GET /api/agents/leaderboard?sinceHours=168  — ranked activity scorecard
 *
 * Gated on `agent:read` (same oversight tier as the readiness board). Does NOT
 * expose a close rate / conversion metric — MediFlow records no per-call
 * outcomes yet, so that is not derivable (see the read model's module doc).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { getAgentLeaderboard } from "../lib/agents/leaderboard";

const router: IRouter = Router();

const QuerySchema = z.object({
  // 1 hour .. 90 days (2160h). Default 168h = 7 days.
  sinceHours: z.coerce.number().int().min(1).max(2160).default(168),
});

router.get(
  "/agents/leaderboard",
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
    const result = await getAgentLeaderboard(
      authReq.orgId,
      parsed.data.sinceHours,
      now,
    );

    res.json({
      data: result.data,
      sinceHours: result.sinceHours,
      asOf: result.asOf,
    });
  },
);

export default router;
