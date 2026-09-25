/**
 * Inbound dialer event receiver (spec §6) — sibling to the Twilio webhook
 * route. Mounted OUTSIDE `/api` (no Clerk auth); trust comes from the
 * `X-MB-Signature` HMAC instead.
 *
 * POST /api/dialer/v1/events
 *
 * Pipeline:
 *   1. Verify `X-MB-Signature` (HMAC-SHA256 over `${t}.${rawBody}`, ±5 min)
 *      using the per-tenant shared secret resolved from `orgId` (§4.2).
 *   2. Idempotent on `eventId` — duplicate / retried / out-of-order deliveries
 *      are deduped via the `dialer_events` PK (§6.2).
 *   3. Land every event in the agencyBRIDGE audit log (§9).
 *   4. Dispatch to a per-type handler; unknown types + unknown fields are
 *      ignored, not errored (§6.2).
 *
 * The route is mounted at `/api/dialer/v1` so the path matches the spec
 * (`callbackUrl: .../api/dialer/v1/events`) while still living above the
 * Clerk-guarded `/api` router. It is registered before `app.use("/api", ...)`.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { db, dialerEventsTable, auditLogTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  verifyWebhookSignature,
  resolveWebhookSecret,
} from "../lib/dialer/signature";
import {
  dialerEventEnvelopeSchema,
  type DialerEventEnvelope,
} from "../lib/dialer/events";
import { dispatchEvent } from "../lib/dialer/handlers";

const router: IRouter = Router();

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

async function auditEvent(
  env: DialerEventEnvelope,
  req: Request,
  outcome: { handled: boolean; note?: string },
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: env.orgId,
      userId: null,
      userRole: null,
      action: "create",
      resourceType: "dialer_event",
      resourceId: env.eventId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      changes: {
        type: env.type,
        dialTicketId: env.dialTicketId ?? null,
        dialerCallId: env.dialerCallId ?? null,
        occurredAt: env.occurredAt ?? null,
        handled: outcome.handled,
        note: outcome.note ?? null,
      },
    });
  } catch (err) {
    logger.error({ err }, "Dialer event: failed to write audit log entry");
  }
}

router.post(
  "/api/dialer/v1/events",
  async (req: RawBodyRequest, res: Response): Promise<void> => {
    // express.json (with the rawBody verify hook in app.ts) has already
    // parsed the body; the raw bytes are needed for the HMAC.
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    // Parse the envelope first (tolerant: unknown fields preserved). We need
    // orgId to pick the per-tenant signing secret.
    const parsed = dialerEventEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid event envelope" });
      return;
    }
    const env = parsed.data;

    // --- Signature verification (§4.2) ---
    const secret = resolveWebhookSecret(env.orgId);
    const sigHeader = req.headers["x-mb-signature"];
    const header = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const verdict = verifyWebhookSignature({ secret, header, rawBody });
    if (!verdict.ok) {
      const status = verdict.reason === "stale" ? 403 : 401;
      logger.warn(
        { reason: verdict.reason, orgId: env.orgId },
        "Dialer event: signature rejected",
      );
      res.status(status).json({ error: `Signature ${verdict.reason}` });
      return;
    }

    try {
      // --- Idempotency on eventId (§6.2) ---
      // The dialer_events PK is the eventId; a duplicate delivery becomes a
      // no-op insert. We branch on whether the row was newly inserted so the
      // (side-effecting) handler runs exactly once per event.
      const inserted = await db
        .insert(dialerEventsTable)
        .values({
          id: env.eventId,
          orgId: env.orgId,
          type: env.type,
          dialTicketId: env.dialTicketId ?? null,
          dialerCallId: env.dialerCallId ?? null,
          schemaVersion:
            env.schemaVersion !== undefined ? String(env.schemaVersion) : null,
          occurredAt: env.occurredAt ? new Date(env.occurredAt) : null,
          payload: env,
        })
        .onConflictDoNothing({ target: dialerEventsTable.id })
        .returning({ id: dialerEventsTable.id });

      if (inserted.length === 0) {
        // Already processed on a previous delivery — ack so the dialer stops
        // retrying, but do not re-run handlers or re-audit.
        logger.info(
          { eventId: env.eventId, type: env.type },
          "Dialer event: duplicate delivery — deduped",
        );
        res.status(200).json({ status: "duplicate", eventId: env.eventId });
        return;
      }

      const outcome = await dispatchEvent(env);
      await auditEvent(env, req, outcome);

      if (!outcome.ok) {
        // Genuine processing failure — surface 5xx so the dialer retries.
        res.status(500).json({ error: "Event processing failed" });
        return;
      }

      res.status(200).json({
        status: outcome.handled ? "accepted" : "ignored",
        eventId: env.eventId,
      });
    } catch (err) {
      logger.error(
        { err, eventId: env.eventId },
        "Dialer event: processing error",
      );
      res.status(500).json({ error: "Event processing failed" });
    }
  },
);

export default router;
