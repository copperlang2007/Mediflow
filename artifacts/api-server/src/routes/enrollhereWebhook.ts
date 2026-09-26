/**
 * EnrollHere inbound webhook: upsert the caller as a contact and log the call.
 *
 *   POST /api/integrations/enrollhere/v1/:orgId/events
 *
 * Mounted OUTSIDE the Clerk-guarded `/api` router (like the dialer and queue
 * receivers) because EnrollHere has no Clerk session. Trust comes from a
 * per-tenant shared secret (`ENROLLHERE_WEBHOOK_SECRET[_<ORGID>]`), accepted
 * in either form so it works with whatever EnrollHere's webhook settings allow:
 *
 *   1. `X-MB-Signature: t=<unix>,v1=<hex hmac>` over `${t}.${rawBody}` —
 *      preferred: signed and replay-protected (±5 min), same primitive as the
 *      dialer webhook. Use it when a relay (or EnrollHere) can sign.
 *   2. `X-Webhook-Secret: <secret>` or `Authorization: Bearer <secret>` —
 *      for senders that can only attach a static header. Compared in
 *      constant time; HTTPS keeps it off the wire.
 *
 * The secret is never accepted in the query string (it would land in access
 * logs). Fail-closed: no configured secret → every request is rejected.
 *
 * Payload: EnrollHere does not publish a webhook schema, so fields are read
 * tolerantly (see lib/integrations/payload.ts) — the person may be top-level
 * or nested under `contact`/`lead`/`client`, with snake or camel case keys.
 * The field NAMES of every payload are recorded (never values) so a field we
 * don't map yet can be spotted and added.
 *
 * Idempotent: the event is keyed on the sender's call/event id (or a hash of
 * the body when none is sent), so a redelivery returns 200 without logging the
 * call twice.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import crypto, { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import {
  db,
  activitiesTable,
  organizationsTable,
  agentsTable,
  integrationEventsTable,
} from "@workspace/db";
import { verifyWebhookSignature } from "../lib/dialer/signature";
import { canonicalJson, flattenPayload, interpretPayloadContact, normalizeKey, payloadKeyPaths, pick } from "../lib/integrations/payload";
import { loadAgentsByEmail, upsertContact } from "../lib/contactImport";
import { normalizePhone } from "../lib/csvImport";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";

const router: IRouter = Router();
const SOURCE = "enrollhere";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function resolveEnrollHereSecret(orgId: string): string | undefined {
  const key = `ENROLLHERE_WEBHOOK_SECRET_${orgId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[key]?.trim() || process.env.ENROLLHERE_WEBHOOK_SECRET?.trim() || undefined;
}

type AuthResult = { ok: true } | { ok: false; status: 401 | 403 | 503; reason: string };

function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function authenticate(req: RawBodyRequest, orgId: string): AuthResult {
  const secret = resolveEnrollHereSecret(orgId);
  if (!secret) {
    logger.error({ orgId }, "EnrollHere webhook: no secret configured — rejecting");
    // 503, like the Stripe receiver: a server-side setup gap, so the sender
    // retries once the secret is configured instead of dropping the event.
    return { ok: false, status: 503, reason: "unconfigured" };
  }
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  const signature = header("x-mb-signature");
  if (signature) {
    // The HMAC is over the exact bytes received; re-serializing the parsed
    // body would never match, so a missing raw body is a server fault.
    const rawBody = req.rawBody;
    if (!rawBody) {
      logger.error({ orgId }, "EnrollHere webhook: raw body not captured; cannot verify signature");
      return { ok: false, status: 401, reason: "unverifiable" };
    }
    const verdict = verifyWebhookSignature({ secret, header: signature, rawBody });
    if (verdict.ok) return { ok: true };
    return { ok: false, status: verdict.reason === "stale" ? 403 : 401, reason: verdict.reason };
  }

  const auth = header("authorization");
  const presented = header("x-webhook-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined);
  if (!presented) return { ok: false, status: 401, reason: "missing" };
  return constantTimeEqual(presented, secret) ? { ok: true } : { ok: false, status: 401, reason: "mismatch" };
}

// Aliases for call fields, as normalized keys (see normalizeKey).
const CALL_ID_KEYS = ["call_id", "call_uuid", "call_sid", "event_id", "id", "uuid"];
const EVENT_KEYS = ["event", "event_type", "type", "trigger"];
const DIRECTION_KEYS = ["direction", "call_direction", "call_type"];
const DURATION_KEYS = ["duration_seconds", "duration", "call_duration", "talk_time", "billsec", "call_length"];
const DISPOSITION_KEYS = ["disposition", "call_disposition", "outcome", "call_result", "result", "call_status", "status"];
const RECORDING_KEYS = ["recording_url", "recording", "recording_link", "call_recording_url"];
// A bare "date" is deliberately absent: vendors use it for submission or appointment dates.
// Not "timestamp": that is a delivery field (see VOLATILE_KEYS) and changes on retry.
const STARTED_KEYS = ["started_at", "start_time", "call_start", "call_started_at", "created_at"];

/**
 * Per-delivery transport fields that change on a retry of the SAME event.
 * They are left out of the id-less fallback hash so a retry still dedupes.
 */
const VOLATILE_KEYS = new Set([
  "timestamp", "sent_at", "delivered_at", "delivery_id", "webhook_id", "attempt",
  "attempt_number", "retry", "retry_count", "nonce", "received_at", "now", "request_id",
  // A whole block of delivery/transport details (e.g. { delivery: { id, attempt } }).
  "delivery",
]);

/** The body with delivery metadata removed at every depth (it changes on retry). */
function stableForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !VOLATILE_KEYS.has(normalizeKey(k)))
      .map(([k, v]) => [k, stableForHash(v)]));
  }
  return value;
}
const CALLER_PHONE_KEYS = ["caller_id", "caller_number", "from_number", "from", "ani", "customer_phone"];
const AGENT_EMAIL_KEYS = ["agent_email", "user_email", "rep_email", "assigned_agent_email", "agent_email_address"];

function parseDurationSeconds(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  const parts = raw.split(":").map(Number); // "mm:ss" or "hh:mm:ss"
  if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  return null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

router.post(
  "/api/integrations/enrollhere/v1/:orgId/events",
  async (req: RawBodyRequest, res: Response): Promise<void> => {
    const orgId = String(req.params.orgId ?? "");
    // JSON only: without this, a delivery missing its Content-Type would reach
    // the handler unparsed (and a form-encoded one would be accepted).
    // Exactly application/json: that is the only type the JSON parser (and its
    // raw-body capture for HMAC) runs for.
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Expected Content-Type: application/json" });
      return;
    }
    const auth = authenticate(req, orgId);
    if (!auth.ok) {
      logger.warn({ orgId, reason: auth.reason }, "EnrollHere webhook: rejected");
      res.status(auth.status).json({ error: `Unauthorized (${auth.reason})` });
      return;
    }

    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, orgId)).limit(1);
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }

    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      res.status(400).json({ error: "Expected a JSON object body" });
      return;
    }

    // Person fields and event fields are read from differently-ordered views
    // so `contact.id` can never be taken for the call id (or vice versa).
    const flat = flattenPayload(req.body, "person-first");
    // Event/call fields come only from the event itself — never from the
    // person block, whose `id` would otherwise be taken for the call id and
    // make every later call for that person look like a duplicate.
    const eventFlat = flattenPayload(req.body, "event-only");
    const keys = payloadKeyPaths(req.body);
    const externalId = pick(eventFlat, CALL_ID_KEYS)
      ?? `sha256:${crypto.createHash("sha256").update(canonicalJson(stableForHash(req.body))).digest("hex")}`;
    const eventType = pick(eventFlat, EVENT_KEYS);

    // The caller's number often arrives as call metadata rather than a contact field.
    // Fall back to the caller ID when the payload's own phone is missing or
    // isn't a number ("Unknown", "Restricted", a display name).
    if (!normalizePhone(flat.phone ?? "") && !normalizePhone(flat.phone_number ?? "")) {
      // Only a value that is actually a phone number (caller_id is often a
      // display name such as "JOHN DOE").
      const caller = normalizePhone(pick(eventFlat, CALLER_PHONE_KEYS) ?? "");
      if (caller?.startsWith("+")) {
        flat.phone = caller;
        delete flat.phone_number;
      }
    }
    const agentEmail = pick(flat, AGENT_EMAIL_KEYS);
    if (agentEmail && !flat.assigned_agent_email) flat.assigned_agent_email = agentEmail;
    // Agent/user/rep fields describe the agent, not the beneficiary. Remove
    // them so e.g. `user_email` / `rep_phone` can't be read as the contact's
    // own email or phone (the header recognizer maps anything with "email").
    for (const key of Object.keys(flat)) {
      if (key !== "assigned_agent_email" && (AGENT_EMAIL_KEYS.includes(key) || /^(agent|user|rep|owner|writing_agent)_/.test(key))) {
        delete flat[key];
      }
    }

    const interpreted = interpretPayloadContact(flat);
    const contact = interpreted.contact;

    // A contact row needs a name, and a call logged against no contact is
    // invisible in the CRM. Reject clearly (422, not retried) and name the
    // fields we did receive so the mapping can be fixed.
    if (!contact) {
      const reason = interpreted.issues.find((i) => i.severity === "error")?.message ?? "Contact could not be read";
      logger.warn({ orgId, keys }, "EnrollHere webhook: payload has no usable contact");
      res.status(422).json({ error: reason, fieldsReceived: keys });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const eventRowId = randomUUID();
        const [claimed] = await tx.insert(integrationEventsTable).values({
          id: eventRowId,
          orgId,
          source: SOURCE,
          externalId,
          eventType,
          payloadKeys: keys,
        }).onConflictDoNothing().returning({ id: integrationEventsTable.id });
        if (!claimed) return { duplicate: true as const };

        const agentsByEmail = contact.assignedAgentEmail
          ? await loadAgentsByEmail(orgId, tx, contact.assignedAgentEmail)
          : new Map<string, string>();
        const agentId = contact.assignedAgentEmail ? agentsByEmail.get(contact.assignedAgentEmail) ?? null : null;
        // The agent made the call: credit it to their login so per-agent call
        // counts (grouped by the activity's author) include EnrollHere calls.
        const agentUserId = agentId
          ? (await tx.select({ userId: agentsTable.userId }).from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1))[0]?.userId ?? null
          : null;
        if (!contact.leadSource) contact.leadSource = "EnrollHere";

        const { contactId, created, matchedOn, warnings: mergeWarnings } = await upsertContact(tx, orgId, contact, agentId);

        const direction = pick(eventFlat, DIRECTION_KEYS)?.toLowerCase() ?? null;
        const durationSeconds = parseDurationSeconds(pick(eventFlat, DURATION_KEYS));
        const disposition = pick(eventFlat, DISPOSITION_KEYS);
        // Only an https link is kept: it is rendered as a clickable link.
        const recordingRaw = pick(eventFlat, RECORDING_KEYS);
        const recordingUrl = recordingRaw && /^https:\/\//i.test(recordingRaw) ? recordingRaw : null;
        const startedAt = pick(eventFlat, STARTED_KEYS);
        const phone = normalizePhone(flat.phone ?? flat.phone_number ?? "");

        const summary = [
          `EnrollHere ${direction ? `${direction} ` : ""}call`,
          durationSeconds !== null ? formatDuration(durationSeconds) : null,
          disposition ? `— ${disposition}` : null,
        ].filter(Boolean).join(" ");

        const activityId = randomUUID();
        await tx.insert(activitiesTable).values({
          id: activityId,
          orgId,
          contactId,
          agentId,
          createdBy: agentUserId,
          type: "call_log",
          body: summary,
          metadata: {
            source: SOURCE,
            externalId,
            eventType,
            direction,
            durationSeconds,
            disposition,
            recordingUrl,
            startedAt,
            phone,
          },
        });
        await tx.update(integrationEventsTable).set({ contactId, activityId })
          .where(eq(integrationEventsTable.id, eventRowId));
        return { duplicate: false as const, contactId, created, matchedOn, activityId, mergeWarnings };
      });

      if (result.duplicate) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.info({ orgId, contactId: result.contactId, created: result.created, matchedOn: result.matchedOn }, "EnrollHere webhook: call logged");
      res.status(200).json({
        ok: true,
        duplicate: false,
        contactId: result.contactId,
        contactCreated: result.created,
        activityId: result.activityId,
        warnings: [...interpreted.issues.map((i) => i.message), ...result.mergeWarnings.map((w) => w.message)],
      });
    } catch (err) {
      logger.error({ err, orgId }, "EnrollHere webhook: failed to process event");
      captureWorkerError(err, { worker: "enrollhere-webhook", orgId });
      // 500 so the sender retries; the idempotency row rolled back with the transaction.
      res.status(500).json({ error: "Failed to process event" });
    }
  },
);

export default router;
