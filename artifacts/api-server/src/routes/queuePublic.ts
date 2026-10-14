/**
 * Public inbound-lead routing endpoint for external callers (GoHighLevel via
 * the Atlas proxy). Mounted OUTSIDE the sign-in-guarded `/api` router — exactly
 * like the dialer event receiver — because GHL has no sign-in session. Trust is
 * established by an HMAC signature instead.
 *
 *   POST /api/queue/v1/route-inbound
 *
 * Auth: `X-MB-Signature: t=<unixSeconds>,v1=<hex hmac>` over `${t}.${rawBody}`
 * (±5 min), keyed by a per-tenant shared secret resolved from the body's
 * `orgId` (env `LEAD_QUEUE_WEBHOOK_SECRET[_<ORGID>]`). Reuses the exact
 * verification primitive the dialer webhook uses (lib/dialer/signature.ts).
 *
 * Body: { orgId, carrierId?|carrierName?, contactState?, contactId?,
 *         certificationYear?, requireAhip?, availableOnly? }
 *
 * Returns the same shape as the in-app route (incl. flat `target_phone` /
 * `target_user_id`) via the shared lib/leadQueue/service.ts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { verifyWebhookSignature } from "../lib/dialer/signature";
import { resolveAndRouteInbound } from "../lib/leadQueue/service";
import { logger } from "../lib/logger";

const router: IRouter = Router();

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Per-tenant shared secret for the public queue endpoint. Mirrors the dialer's
 * `resolveWebhookSecret` but with a distinct env namespace so the two
 * integrations hold independent credentials.
 */
export function resolveQueueWebhookSecret(orgId?: string): string | undefined {
  if (orgId) {
    const key = `LEAD_QUEUE_WEBHOOK_SECRET_${orgId
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")}`;
    const perTenant = process.env[key]?.trim();
    if (perTenant) return perTenant;
  }
  return process.env.LEAD_QUEUE_WEBHOOK_SECRET?.trim() || undefined;
}

const BodySchema = z.object({
  orgId: z.string().min(1),
  carrierId: z.string().min(1).optional(),
  carrierName: z.string().min(1).optional(),
  contactState: z.string().min(2).max(2).optional(),
  contactId: z.string().min(1).optional(),
  certificationYear: z.number().int().min(2000).max(2100).optional(),
  requireAhip: z.boolean().optional(),
  availableOnly: z.boolean().optional(),
});

router.post(
  "/api/queue/v1/route-inbound",
  async (req: RawBodyRequest, res: Response): Promise<void> => {
    // express.json (with the rawBody verify hook in app.ts) already parsed the
    // body; the raw bytes are what the HMAC is computed over.
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    // --- Signature verification ---
    const secret = resolveQueueWebhookSecret(body.orgId);
    const sigHeader = req.headers["x-mb-signature"];
    const header = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const verdict = verifyWebhookSignature({ secret, header, rawBody });
    if (!verdict.ok) {
      const status = verdict.reason === "stale" ? 403 : 401;
      logger.warn(
        { reason: verdict.reason, orgId: body.orgId },
        "Queue route-inbound: signature rejected",
      );
      res.status(status).json({ error: `Signature ${verdict.reason}` });
      return;
    }

    const outcome = await resolveAndRouteInbound({
      orgId: body.orgId,
      carrierId: body.carrierId,
      carrierName: body.carrierName,
      contactState: body.contactState,
      contactId: body.contactId,
      certificationYear: body.certificationYear,
      requireAhip: body.requireAhip,
      availableOnly: body.availableOnly,
      source: "public",
    });
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    res.json(outcome.body);
  },
);

export default router;
