/**
 * Inbound lead queue API.
 *
 * Replaces the standalone `atlas-call-router` stub (which returned a
 * hard-coded number) with a real, data-backed router that filters agents by
 * "ready to sell" status for the lead's carrier + state and ranks the
 * eligible pool by current workload. See lib/leadQueue/readyToSell.ts and
 * docs/inbound-lead-queue.md.
 *
 *   GET  /api/queue/ready-to-sell   — list eligible agents for state+carrier
 *   POST /api/queue/route-inbound   — pick the next agent for an inbound lead
 *
 * `route-inbound` doubles as the drop-in replacement for the GHL HTTP-Request
 * step: it accepts `{contactState, carrierId}` and returns a `target_phone`,
 * matching the field the old Atlas service produced, so the GHL "Connect
 * Call" action can point straight at MediFlow.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, contactsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import {
  findReadyToSellAgents,
  routeInboundLead,
} from "../lib/leadQueue/readyToSell";

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

const requireAhip = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true")
  .optional();

// GET /queue/ready-to-sell?stateCode=FL&carrierId=...&certificationYear=2026
const ReadyToSellQuerySchema = z.object({
  stateCode,
  carrierId: z.string().min(1),
  certificationYear,
  requireAhip,
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
    const { stateCode, carrierId, certificationYear, requireAhip } =
      parsed.data;

    const agents = await findReadyToSellAgents({
      orgId: authReq.orgId,
      stateCode,
      carrierId,
      certificationYear,
      requireAhip,
    });

    res.json({
      data: agents,
      total: agents.length,
      stateCode,
      carrierId,
      certificationYear: certificationYear ?? new Date().getUTCFullYear(),
    });
  },
);

// POST /queue/route-inbound
// Body: { carrierId, contactState?, contactId?, certificationYear?, requireAhip? }
// When `contactId` is supplied, the lead's state is read from the contact
// record (the GHL payload usually carries the raw state instead — either works,
// and an explicit `contactState` always wins).
const RouteInboundSchema = z.object({
  carrierId: z.string().min(1),
  contactState: stateCode.optional(),
  contactId: z.string().min(1).optional(),
  certificationYear,
  requireAhip,
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
    const {
      carrierId,
      contactState,
      contactId,
      certificationYear,
      requireAhip,
    } = parsed.data;

    // Resolve the lead's state: explicit `contactState` wins; otherwise fall
    // back to the contact record (org-scoped lookup).
    let resolvedState = contactState ?? null;
    if (!resolvedState && contactId) {
      const [contact] = await db
        .select({ stateCode: contactsTable.stateCode })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.id, contactId),
            eq(contactsTable.orgId, authReq.orgId),
          ),
        )
        .limit(1);
      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      resolvedState = contact.stateCode
        ? contact.stateCode.toUpperCase()
        : null;
    }

    if (!resolvedState) {
      res.status(400).json({
        error:
          "Could not determine the lead's state — provide `contactState` or a `contactId` whose contact has a stateCode.",
      });
      return;
    }

    const result = await routeInboundLead({
      orgId: authReq.orgId,
      stateCode: resolvedState,
      carrierId,
      certificationYear,
      requireAhip,
    });

    res.json({
      status: result.status,
      stateCode: resolvedState,
      carrierId,
      candidatePool: result.candidatePool,
      agent: result.agent,
      // Atlas/GHL-compatible flat fields for the "Connect Call" step. Null
      // when no agent is available so the workflow can branch on it.
      target_phone: result.agent?.phone ?? null,
      target_user_id: result.agent?.agentId ?? null,
    });
  },
);

export default router;
