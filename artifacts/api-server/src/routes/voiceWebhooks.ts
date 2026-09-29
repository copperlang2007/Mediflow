/**
 * Twilio Voice webhooks for native browser calling. Mounted in app.ts ABOVE
 * the Clerk-guarded `/api` router (Twilio has no Clerk session): trust comes
 * from the X-Twilio-Signature HMAC, validated with the same validator and
 * TWILIO_WEBHOOK_PUBLIC_HOST host pinning as the SMS webhook.
 *
 *   POST /api/webhooks/twilio/voice         TwiML App Voice URL. The browser
 *        started a call with { callSessionId, To }. We dial the number STORED on
 *        the call session — never anything from the request — and only if the
 *        session is unused, unexpired, bound to the calling user, and the
 *        number still clears the opt-out check. Anything else: <Reject>.
 *   POST /api/webhooks/twilio/voice-status  Call status / <Dial action>
 *        results. Ordered + idempotent; logs the call once on completion.
 *   POST /api/webhooks/twilio/voice-notice  Recording notice played to the
 *        callee before bridging (only used when recording_enabled is true).
 *
 * Failure to verify the signature returns 403 and touches nothing.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, auditLogTable, callSessionsTable, usersTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { isDemoMode } from "../lib/demoMode";
import { verifiedTwilioParams } from "../lib/voice/twilioWebhook";
import { toDialableE164 } from "../lib/voice/phone";
import { voiceCallerId, voiceIdentity } from "../lib/voice/voiceToken";
import {
  CALL_SESSION_TTL_MS,
  applyStatusUpdate,
  blockUnusedSession,
  claimSessionForDial,
  recheckContactAtDial,
} from "../lib/voice/callSessions";
import { dialTwiml, emptyTwiml, recordingNoticeTwiml, rejectTwiml } from "../lib/voice/twiml";

const router: IRouter = Router();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDemoMode() ? 2000 : 1200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false },
  message: { error: "Too many requests" },
});

const CALL_SID = /^CA[0-9A-Za-z]{32}$/;

function sendTwiml(res: Response, xml: string): void {
  res.status(200).type("text/xml").send(xml);
}

/** Audit a webhook-side decision. Reasons and ids only — never numbers. */
async function auditVoice(
  orgId: string,
  sessionId: string,
  action: string,
  changes: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId,
      userId: null,
      userRole: null,
      action,
      resourceType: "call",
      resourceId: sessionId,
      changes,
    });
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to write voice audit entry");
  }
}

router.post(
  "/api/webhooks/twilio/voice",
  webhookLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const params = verifiedTwilioParams(req);
    if (!params) {
      logger.warn("Twilio voice webhook: invalid signature — rejected");
      res.status(403).type("text/xml").send(emptyTwiml());
      return;
    }

    const sessionId = params.callSessionId ?? "";
    const callSid = params.CallSid ?? "";
    // Never dial on anything but a well-formed session id and CallSid.
    if (!sessionId || sessionId.length > 100 || !CALL_SID.test(callSid)) {
      sendTwiml(res, rejectTwiml());
      return;
    }

    const [session] = await db
      .select()
      .from(callSessionsTable)
      .where(eq(callSessionsTable.id, sessionId))
      .limit(1);
    if (!session) {
      sendTwiml(res, rejectTwiml());
      return;
    }

    // Decide, in order, why this must NOT dial. `null` = every check passed.
    const decide = async (): Promise<string | null> => {
      if (session.direction !== "outbound") return "not_outbound";
      if (session.status !== "initiated") return "not_initiated";
      if (Date.now() - session.createdAt.getTime() > CALL_SESSION_TTL_MS) return "expired";
      // The browser echoes the number it believes it is calling; it must match
      // what we stored. (The stored number is what gets dialed either way.)
      const echoed = toDialableE164(params.To);
      if (!echoed || echoed !== session.toNumber) return "number_mismatch";
      // Bind the session to the user who created it: Twilio sets From to
      // client:<token identity>, which is signed into the access token.
      if (!session.userId || params.From !== `client:${voiceIdentity(session.userId)}`) {
        return "identity_mismatch";
      }
      if (!toDialableE164(session.toNumber)) return "invalid_number";
      const [user] = await db
        .select({ isActive: usersTable.isActive, orgId: usersTable.orgId })
        .from(usersTable)
        .where(eq(usersTable.id, session.userId))
        .limit(1);
      if (!user || !user.isActive || user.orgId !== session.orgId) return "identity_mismatch";
      // A STOP / do_not_contact that landed since preclearance must win.
      const recheck = await recheckContactAtDial(session);
      if (recheck !== "ok") return recheck;
      return null;
    };

    const failure = await decide();
    const callerId = session.fromNumber ?? voiceCallerId();
    if (failure || !callerId) {
      const reason = failure ?? "no_caller_id";
      // Only an unused session is marked blocked; a replay against a session
      // already in use must not kill the real call.
      const marked = await blockUnusedSession(session.id, reason);
      await auditVoice(session.orgId, session.id, "call_voice_rejected", { reason, marked });
      logger.warn({ callSessionId: session.id, reason }, "Voice webhook rejected call");
      sendTwiml(res, rejectTwiml());
      return;
    }

    // Atomic single-use claim: exactly one delivery can win.
    const claim = await claimSessionForDial(session.id, callSid);
    if (!claim.ok) {
      await auditVoice(session.orgId, session.id, "call_voice_rejected", { reason: claim.reason, marked: false });
      logger.warn({ callSessionId: session.id, reason: claim.reason }, "Voice webhook claim lost");
      sendTwiml(res, rejectTwiml());
      return;
    }

    await auditVoice(session.orgId, session.id, "call_voice_dialed", {
      recording: session.recordingEnabled,
    });
    // Dial ONLY the stored number and caller id.
    sendTwiml(
      res,
      dialTwiml({
        to: claim.session.toNumber,
        callerId,
        recording: claim.session.recordingEnabled,
      }),
    );
  },
);

router.post(
  "/api/webhooks/twilio/voice-status",
  webhookLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const params = verifiedTwilioParams(req);
    if (!params) {
      logger.warn("Twilio voice status: invalid signature — rejected");
      res.status(403).type("text/xml").send(emptyTwiml());
      return;
    }
    const callSid = params.CallSid ?? "";
    if (!CALL_SID.test(callSid)) {
      sendTwiml(res, emptyTwiml());
      return;
    }
    // <Dial action> posts DialCallStatus/DialCallDuration (the callee leg —
    // the true outcome and talk time); the TwiML App's status callback posts
    // CallStatus/CallDuration for the browser leg. Prefer the callee leg.
    const dialStatus = params.DialCallStatus;
    try {
      const outcome = await applyStatusUpdate({
        callSid,
        twilioStatus: dialStatus || params.CallStatus,
        durationRaw: dialStatus ? params.DialCallDuration : params.CallDuration,
      });
      if (outcome.applied) {
        const [row] = await db
          .select({ id: callSessionsTable.id, orgId: callSessionsTable.orgId })
          .from(callSessionsTable)
          .where(eq(callSessionsTable.twilioCallSid, callSid))
          .limit(1);
        if (row) {
          await auditVoice(row.orgId, row.id, "call_status", {
            status: outcome.status,
            logged: outcome.activityId != null,
          });
        }
      }
    } catch (err) {
      // 5xx makes Twilio retry; the update is idempotent so that is safe.
      logger.error({ err }, "Failed to apply Twilio voice status");
      res.status(500).type("text/xml").send(emptyTwiml());
      return;
    }
    // Empty TwiML is a valid answer to both a status callback and <Dial action>
    // (it simply ends the call).
    sendTwiml(res, emptyTwiml());
  },
);

router.post(
  "/api/webhooks/twilio/voice-notice",
  webhookLimiter,
  (req: Request, res: Response): void => {
    if (!verifiedTwilioParams(req)) {
      res.status(403).type("text/xml").send(emptyTwiml());
      return;
    }
    sendTwiml(res, recordingNoticeTwiml());
  },
);

export default router;
