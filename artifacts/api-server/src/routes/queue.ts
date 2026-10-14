/**
 * Inbound lead queue API (signed-in, in-app surface).
 *
 * Replaces the standalone `atlas-call-router` stub (which returned a
 * hard-coded number) with a real, data-backed router that filters agents by
 * "ready to sell" status for the lead's carrier + state, intersects with live
 * presence, and ranks by current workload. See lib/leadQueue/* and
 * docs/inbound-lead-queue.md.
 *
 *   GET  /api/queue/ready-to-sell      — list eligible agents for state+carrier
 *   POST /api/queue/route-inbound      — pick the next agent for an inbound lead
 *   POST /api/queue/presence/heartbeat — agent reports availability (self)
 *
 * The EXTERNAL GHL/Atlas entry point is the HMAC-authed sibling in
 * routes/queuePublic.ts (`POST /api/queue/v1/route-inbound`); GHL has no sign-in
 * session. Both share lib/leadQueue/service.ts so routing can't drift.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, agentsTable } from "@workspace/db";
import { sellingPlanYear } from "../lib/compliance/planYear";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { findReadyToSellAgents } from "../lib/leadQueue/readyToSell";
import { resolveAndRouteInbound } from "../lib/leadQueue/service";
import { resolveCarrier } from "../lib/leadQueue/carriers";
import {
  getPresenceOverview,
  getRecentRouting,
  getRoutingStats,
  getCoverageGaps,
} from "../lib/leadQueue/overview";
import {
  listLeadCallbacks,
  cancelLeadCallback,
} from "../lib/leadQueue/callbacks";
import {
  recordHeartbeat,
  getAvailableAgentIds,
  HEARTBEAT_STATUSES,
  type PresenceStatus,
} from "../lib/leadQueue/presence";

const router: IRouter = Router();

const stateCode = z
  .string()
  .trim()
  .length(2, "stateCode must be a 2-letter code")
  .transform((s) => s.toUpperCase());

const certificationYear = z.coerce
  .number()
  .int()
  .min(2000)
  .max(2100)
  .optional();

const boolish = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true")
  .optional();

// A carrier is referenced by id OR name (name resolved server-side, org-scoped).
const carrierRef = {
  carrierId: z.string().min(1).optional(),
  carrierName: z.string().min(1).optional(),
};

// GET /queue/ready-to-sell?stateCode=FL&carrierId=...&availableOnly=true
const ReadyToSellQuerySchema = z.object({
  stateCode,
  ...carrierRef,
  certificationYear,
  requireAhip: boolish,
  availableOnly: boolish,
});

router.get(
  "/queue/ready-to-sell",
  requireAuth,
  requirePermission("lead", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = ReadyToSellQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const {
      stateCode,
      carrierId,
      carrierName,
      certificationYear,
      requireAhip,
      availableOnly,
    } = parsed.data;

    // Resolve the carrier (id or name) up front so the listing matches what
    // route-inbound would consider.
    const carrier = await resolveCarrier({
      orgId: authReq.orgId,
      carrierId,
      carrierName,
    });
    if (!carrier.ok) {
      const status =
        carrier.reason === "ambiguous"
          ? 409
          : carrier.reason === "not_found"
            ? 404
            : 400;
      res.status(status).json({ error: `carrier ${carrier.reason}` });
      return;
    }

    // This listing is "who is eligible". Presence filtering is opt-in here
    // (default off) since the list is also used for reporting, not just live
    // routing.
    let availableAgentIds: string[] | undefined;
    if (availableOnly) {
      const presence = await getAvailableAgentIds(authReq.orgId);
      availableAgentIds = presence.ids;
    }

    const agents = await findReadyToSellAgents({
      orgId: authReq.orgId,
      stateCode,
      carrierId: carrier.carrierId,
      certificationYear,
      requireAhip,
      availableAgentIds,
    });

    res.json({
      data: agents,
      total: agents.length,
      stateCode,
      carrierId: carrier.carrierId,
      certificationYear: certificationYear ?? sellingPlanYear(),
      availableOnly: Boolean(availableOnly),
    });
  },
);

// POST /queue/route-inbound
const RouteInboundSchema = z.object({
  ...carrierRef,
  contactState: stateCode.optional(),
  contactId: z.string().min(1).optional(),
  certificationYear,
  requireAhip: boolish,
  availableOnly: boolish,
});

router.post(
  "/queue/route-inbound",
  requireAuth,
  requirePermission("lead", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = RouteInboundSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const outcome = await resolveAndRouteInbound({
      orgId: authReq.orgId,
      ...parsed.data,
      source: "in_app",
    });
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    res.json(outcome.body);
  },
);

// POST /queue/presence/heartbeat — the authenticated agent reports their own
// availability. The web app calls this on Available/Away toggles and on an
// interval (well inside HEARTBEAT_TTL) so the queue knows who is reachable.
const HeartbeatSchema = z.object({
  status: z
    .enum(["available", "away", "offline"])
    .optional()
    .default("available"),
});

router.post(
  "/queue/presence/heartbeat",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = HeartbeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    // Map the signed-in user to their agent record (presence is per-agent).
    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.userId, authReq.userId),
          eq(agentsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!agent) {
      res
        .status(404)
        .json({ error: "No agent record is linked to this user." });
      return;
    }

    const status = parsed.data.status as PresenceStatus;
    if (!HEARTBEAT_STATUSES.includes(status)) {
      res.status(400).json({ error: "Unsupported heartbeat status." });
      return;
    }

    const row = await recordHeartbeat({
      orgId: authReq.orgId,
      agentId: agent.id,
      status,
    });
    res.json({
      agentId: row.agentId,
      status: row.status,
      expiresAt: row.expiresAt,
    });
  },
);

// GET /queue/presence — admin oversight: every agent's presence row + the live
// `availableNow` verdict. Read-only oversight: gated to the admin tier
// (`agent:admin` = super_admin / agency_admin) so the API matches the
// admin-only Live Queue page rather than the broader lead:read surface.
router.get(
  "/queue/presence",
  requireAuth,
  requirePermission("agent", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    res.json(await getPresenceOverview(authReq.orgId));
  },
);

// GET /queue/routing/recent?limit=50 — recent routing decisions (the
// lead_routing audit trail) for the live-queue view. Admin-tier (see above).
const RecentRoutingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
router.get(
  "/queue/routing/recent",
  requireAuth,
  requirePermission("agent", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = RecentRoutingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const rows = await getRecentRouting(authReq.orgId, parsed.data.limit ?? 50);
    res.json({ data: rows, total: rows.length });
  },
);

// GET /queue/routing/stats?sinceHours=24 — windowed routing analytics + the
// carrier×state coverage-gap list, for the admin Analytics view. Admin-tier
// (`agent:admin`), matching the other oversight endpoints. sinceHours is
// clamped 1..720 (30 days) with a 24h default.
const RoutingStatsQuerySchema = z.object({
  sinceHours: z.coerce.number().int().min(1).max(720).optional(),
});
router.get(
  "/queue/routing/stats",
  requireAuth,
  requirePermission("agent", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = RoutingStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const sinceHours = parsed.data.sinceHours ?? 24;
    const now = new Date();
    const [stats, coverageGaps] = await Promise.all([
      getRoutingStats(authReq.orgId, sinceHours, now),
      getCoverageGaps(authReq.orgId, sinceHours, now),
    ]);
    res.json({ stats, coverageGaps, sinceHours, asOf: now.toISOString() });
  },
);

// ---- Callback SLA queue (admin oversight) -----------------------------------
//
// Dropped inbounds (`no_agent_available`) are captured as `lead_callbacks` and
// auto-resolved by the lead-callback-sweep worker. These endpoints back the
// admin Callbacks panel. Admin-tier (`agent:admin`), matching the other
// oversight endpoints above.

// GET /queue/callbacks?status=open&limit=100 — worked list, SLA-soonest first.
const CallbacksQuerySchema = z.object({
  status: z.enum(["open", "resolved", "expired", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get(
  "/queue/callbacks",
  requireAuth,
  requirePermission("agent", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CallbacksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const rows = await listLeadCallbacks({
      orgId: authReq.orgId,
      status: parsed.data.status ?? "open",
      limit: parsed.data.limit ?? 100,
    });
    res.json({ data: rows, total: rows.length });
  },
);

// POST /queue/callbacks/:id/cancel — mark an open callback cancelled.
const CallbackIdSchema = z.object({ id: z.string().min(1) });
router.post(
  "/queue/callbacks/:id/cancel",
  requireAuth,
  requirePermission("agent", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CallbackIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid callback id", details: parsed.error.issues });
      return;
    }
    const cancelled = await cancelLeadCallback({
      orgId: authReq.orgId,
      id: parsed.data.id,
    });
    if (!cancelled) {
      res
        .status(404)
        .json({ error: "No open callback with that id in this org." });
      return;
    }
    res.json({ id: parsed.data.id, status: "cancelled" });
  },
);

export default router;
