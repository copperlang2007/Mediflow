/**
 * Softphone desk + native browser calling (Twilio Voice).
 *
 * Screen-pop / read side (unchanged):
 *   GET /softphone/lookup?phone=...        — contacts whose phone matches
 *   GET /softphone/precheck?contactId=...  — "OK to call?" using the real
 *                                            dialer preclearance rules
 *   GET /softphone/recent-calls            — latest call_log activities
 *   GET /softphone/dispositions            — the disposition categories the
 *                                            post-call parser also uses
 *
 * Calling:
 *   POST  /softphone/calls        — preclear + create a single-use call session
 *   GET   /softphone/voice-token  — short-lived Twilio Voice access token
 *   GET   /softphone/calls        — recent call sessions (agents: their own)
 *   PATCH /softphone/calls/:id    — disposition + notes (DNC creates an opt-out)
 *
 * The browser NEVER supplies a phone number. POST /softphone/calls takes a
 * contact id; the number is derived here from the contact, stored on the
 * session, and the Twilio Voice webhook (routes/voiceWebhooks.ts) dials only
 * that stored value. The masterBRIDGE issuance path (lib/dialer/issuance.ts)
 * is left untouched on purpose.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  activitiesTable,
  agentsTable,
  contactsTable,
  optOutsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import {
  runPreclearance,
  resolveTimezone,
  DEFAULT_CALLING_HOURS,
  type PreclearanceFailure,
  type ProductLine,
} from "../lib/dialer/preclearance";
import { SUGGESTED_DISPOSITION_CATEGORIES } from "../lib/dialer/transcriptParse";
import { normalizePhone } from "../lib/csvImport";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import { randomUUID } from "node:crypto";
import { auditLogTable, callSessionsTable } from "@workspace/db";
import { isDemoMode } from "../lib/demoMode";
import { cancelUnclaimedSession, expireStaleLiveSessions, placeCall } from "../lib/voice/callSessions";
import { mintVoiceToken, missingVoiceEnv } from "../lib/voice/voiceToken";
import { recordPhoneOptOut } from "../lib/compliance/optOut";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Audit every state-changing call route (POST/PATCH). Reads are not audited.
router.use(
  routerAuditMiddleware(router, "call", undefined, {
    shouldAudit: (req) => !(req as Request & { skipAudit?: boolean }).skipAudit,
    getResourceId: (req) => {
      const fromParam = req.params.id;
      if (typeof fromParam === "string") return fromParam;
      return (req as Request & { callSessionId?: string }).callSessionId ?? null;
    },
  }),
);

/** Digits only; the last 10 are what a US number is matched on. */
function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

// ---- Lookup ----------------------------------------------------------------

const LookupQuery = z.object({
  phone: z
    .string()
    .trim()
    .max(30)
    .refine((v) => {
      const d = phoneDigits(v);
      return d.length >= 7 && d.length <= 15;
    }, "phone must contain 7-15 digits"),
});

router.get(
  "/softphone/lookup",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = LookupQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a phone number with at least 7 digits." });
      return;
    }
    const digits = phoneDigits(parsed.data.phone);
    // Match on the trailing 10 digits (or all of them when shorter) so
    // "+1 (310) 555-0101", "3105550101" and "+13105550101" all find the same
    // contact regardless of how it was stored.
    const tail = digits.length > 10 ? digits.slice(-10) : digits;
    const rows = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        phone: contactsTable.phone,
        email: contactsTable.email,
        status: contactsTable.status,
        stateCode: contactsTable.stateCode,
        zipCode: contactsTable.zipCode,
        currentPlanType: contactsTable.currentPlanType,
        assignedAgentId: contactsTable.assignedAgentId,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
          sql`${contactsTable.phone} IS NOT NULL`,
          sql`regexp_replace(${contactsTable.phone}, '\\D', '', 'g') LIKE ${"%" + tail}`,
        ),
      )
      .orderBy(desc(contactsTable.updatedAt))
      .limit(10);
    res.json({ data: rows, total: rows.length });
  },
);

// ---- Preclearance check ----------------------------------------------------

const PRODUCT_LINES = ["MA", "PDP", "MAPD", "supp", "other"] as const;

const PrecheckQuery = z.object({
  contactId: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100).optional(),
  productLine: z.enum(PRODUCT_LINES).optional(),
});

const AGENT_CODES = new Set<PreclearanceFailure["code"]>([
  "AGENT_NOT_LICENSED",
  "AGENT_LICENSE_EXPIRED",
  "AGENT_NO_AHIP",
  "AGENT_NOT_CERTIFIED",
]);

router.get(
  "/softphone/precheck",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = PrecheckQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const { contactId } = parsed.data;

    const [contact] = await db
      .select({
        id: contactsTable.id,
        phone: contactsTable.phone,
        stateCode: contactsTable.stateCode,
        zipCode: contactsTable.zipCode,
        currentPlanType: contactsTable.currentPlanType,
        assignedAgentId: contactsTable.assignedAgentId,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Which agent's licensing to check: an explicit pick, else the signed-in
    // user's own agent record, else the contact's assigned agent. Always
    // org-scoped — a forged agentId from another org resolves to nothing.
    const agentSelect = {
      id: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
    };
    let agent: { id: string; firstName: string; lastName: string } | null = null;
    let agentSource: "requested" | "you" | "assigned" | null = null;
    if (parsed.data.agentId) {
      [agent = null] = await db.select(agentSelect).from(agentsTable)
        .where(and(eq(agentsTable.id, parsed.data.agentId), eq(agentsTable.orgId, authReq.orgId))).limit(1);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      agentSource = "requested";
    } else {
      const [mine] = await db.select(agentSelect).from(agentsTable)
        .where(and(eq(agentsTable.userId, authReq.userId), eq(agentsTable.orgId, authReq.orgId))).limit(1);
      if (mine) {
        agent = mine;
        agentSource = "you";
      } else if (contact.assignedAgentId) {
        const [assigned] = await db.select(agentSelect).from(agentsTable)
          .where(and(eq(agentsTable.id, contact.assignedAgentId), eq(agentsTable.orgId, authReq.orgId))).limit(1);
        if (assigned) {
          agent = assigned;
          agentSource = "assigned";
        }
      }
    }

    const productLine: ProductLine =
      parsed.data.productLine ?? (contact.currentPlanType as ProductLine | null) ?? "MAPD";
    const now = new Date();

    // The real preclearance rules (licensing/AHIP/certs, consent + DNC,
    // calling hours). Read-only: it only SELECTs. When no agent is known we
    // still run it for the consent / DNC / hours checks and drop the agent
    // results, which would otherwise read as "not licensed".
    const decision = await runPreclearance({
      orgId: authReq.orgId,
      agentId: agent?.id ?? "",
      contactRef: contact.id,
      callee: {
        phone: contact.phone ?? "",
        stateCode: contact.stateCode ?? undefined,
        zipCode: contact.zipCode ?? undefined,
      },
      callbackUrl: "about:blank",
      productLine,
      planYear: now.getUTCFullYear(),
    });

    let failures: PreclearanceFailure[] = [...(decision.failures ?? [])];
    if (!agent) failures = failures.filter((f) => !AGENT_CODES.has(f.code));

    // The shared rule matches opt-outs on the exact stored string. Also check
    // the E.164 form so a number saved as "(310) 555-0101" still hits a
    // STOP recorded from Twilio as "+13105550101".
    if (contact.phone && !failures.some((f) => f.code === "DNC")) {
      const variants = [...new Set([contact.phone, normalizePhone(contact.phone)].filter(Boolean) as string[])];
      const [hit] = await db
        .select({ id: optOutsTable.id })
        .from(optOutsTable)
        .where(and(eq(optOutsTable.orgId, authReq.orgId), inArray(optOutsTable.phone, variants)))
        .limit(1);
      if (hit) {
        failures.push({ code: "DNC", detail: "callee phone is on the org DNC / opt-out list" });
      }
    }
    if (!contact.phone) {
      failures.push({ code: "MISSING_INPUT", detail: "contact has no phone number on file" });
    }

    const tz = resolveTimezone(contact.stateCode ?? undefined, undefined);
    const localTime = tz
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now)
      : null;
    const has = (c: PreclearanceFailure["code"]) => failures.some((f) => f.code === c);

    res.set("Cache-Control", "no-store");
    res.json({
      okToCall: failures.length === 0 && agent !== null,
      checks: {
        consent: !has("NO_CONSENT"),
        dncClear: !has("DNC"),
        withinCallingHours: tz ? !has("OUTSIDE_CALLING_HOURS") : null,
        agentEligible: agent
          ? ![...AGENT_CODES].some((c) => has(c)) && !has("MISSING_INPUT")
          : null,
      },
      failures,
      agent: agent
        ? { id: agent.id, name: `${agent.firstName} ${agent.lastName}`.trim(), source: agentSource }
        : null,
      productLine,
      planYear: now.getUTCFullYear(),
      callingHours: { ...DEFAULT_CALLING_HOURS, timezone: tz, localTime },
      checkedAt: now.toISOString(),
    });
  },
);

// ---- Recent call logs ------------------------------------------------------

const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

router.get(
  "/softphone/recent-calls",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = RecentQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const rows = await db
      .select({
        id: activitiesTable.id,
        contactId: activitiesTable.contactId,
        body: activitiesTable.body,
        metadata: activitiesTable.metadata,
        createdAt: activitiesTable.createdAt,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        phone: contactsTable.phone,
      })
      .from(activitiesTable)
      .innerJoin(
        contactsTable,
        and(
          eq(contactsTable.id, activitiesTable.contactId),
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
        ),
      )
      .where(and(eq(activitiesTable.orgId, authReq.orgId), eq(activitiesTable.type, "call_log")))
      .orderBy(desc(activitiesTable.createdAt))
      .limit(parsed.data.limit ?? 15);
    res.json({ data: rows, total: rows.length });
  },
);

// ---- Dispositions ----------------------------------------------------------

/**
 * Codes an agent can save on a call: the shared categories the post-call
 * transcript parser also uses, plus DO_NOT_CALL — "the person asked not to be
 * called again" — which records an opt-out for the number (see PATCH below).
 */
export const CALL_DISPOSITION_CODES = [...SUGGESTED_DISPOSITION_CATEGORIES, "DO_NOT_CALL"] as const;
export type CallDispositionCode = (typeof CALL_DISPOSITION_CODES)[number];

const DISPOSITION_LABELS: Record<CallDispositionCode, string> = {
  POSITIVE: "Interested / moving forward",
  NEUTRAL: "Spoke — no decision",
  NEGATIVE: "Not interested",
  COMPLIANCE: "Compliance concern",
  FOLLOW_UP: "Call back / follow up",
  UNKNOWN: "No answer / unknown",
  DO_NOT_CALL: "Do not call again",
};

router.get(
  "/softphone/dispositions",
  requireAuth,
  requirePermission("contact", "read"),
  (_req: Request, res: Response): void => {
    res.json({
      data: CALL_DISPOSITION_CODES.map((code) => ({
        code,
        label: DISPOSITION_LABELS[code],
      })),
    });
  },
);

// ---- Native calling ----------------------------------------------------------

const PlaceCallBody = z
  .object({
    contactId: z.string().min(1).max(100),
    productLine: z.enum(PRODUCT_LINES).optional(),
  })
  // Deliberately strict: a `phone` / `to` / `number` field is rejected outright
  // so no client can even attempt to name a destination.
  .strict();

/**
 * POST /softphone/calls — preclear a call to a contact and create the
 * single-use session the browser then dials with. 409 = refused (with the
 * specific reasons); a `blocked` row is stored as the audit trail.
 */
router.post(
  "/softphone/calls",
  requireAuth,
  requirePermission("call", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    res.set("Cache-Control", "no-store");
    if (isDemoMode()) {
      res.status(503).json({ status: "demo_mode", error: "Calling is disabled in demo mode." });
      return;
    }
    const parsed = PlaceCallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const result = await placeCall({
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      contactId: parsed.data.contactId,
      productLine: parsed.data.productLine,
    });
    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Contact not found" });
        return;
      case "needs_setup":
        res.status(503).json({ status: "needs_setup", missing: result.missing });
        return;
      case "throttled":
        // Refused without storing a row (abandoned-attempt ceiling).
        res.status(409).json({
          error: result.reasons[0]?.detail ?? "Too many call attempts.",
          code: result.reasons[0]?.code,
          reasons: result.reasons,
        });
        return;
      case "blocked":
        (req as Request & { callSessionId?: string }).callSessionId = result.callSessionId;
        res.status(409).json({
          error: result.reasons[0]?.detail ?? "This call is not allowed right now.",
          code: result.reasons[0]?.code,
          reasons: result.reasons,
          callSessionId: result.callSessionId,
        });
        return;
      case "ok":
        (req as Request & { callSessionId?: string }).callSessionId = result.callSessionId;
        res.status(201).json({ callSessionId: result.callSessionId, to: result.to });
        return;
    }
  },
);

/**
 * GET /softphone/voice-token — a short-lived Twilio Voice access token whose
 * identity is the signed-in user. 503 {status:"needs_setup", missing:[names]}
 * until every Twilio env var is set, so the UI can say so honestly.
 */
router.get(
  "/softphone/voice-token",
  requireAuth,
  requirePermission("call", "create"),
  (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    res.set("Cache-Control", "no-store");
    if (isDemoMode()) {
      res.status(503).json({ status: "demo_mode", error: "Calling is disabled in demo mode." });
      return;
    }
    // A super admin "viewing" another agency must not mint a calling token.
    if (authReq.viewOnly) {
      res.status(403).json({ error: "View-only mode does not allow calling", code: "VIEW_ONLY_MODE" });
      return;
    }
    const missing = missingVoiceEnv();
    if (missing.length > 0) {
      res.status(503).json({ status: "needs_setup", missing });
      return;
    }
    const minted = mintVoiceToken(authReq.userId);
    res.json({
      token: minted.token,
      identity: minted.identity,
      expiresAt: minted.expiresAt,
      ttlSeconds: minted.ttlSeconds,
    });
  },
);

const CallsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  contactId: z.string().min(1).max(100).optional(),
});

/** GET /softphone/calls — recent call sessions; the `agent` role sees only its own. */
router.get(
  "/softphone/calls",
  requireAuth,
  requirePermission("call", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CallsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const c = callSessionsTable;
    // Lazily close out sessions whose terminal callback never arrived.
    await expireStaleLiveSessions(db, authReq.orgId);
    const conditions = [eq(c.orgId, authReq.orgId)];
    if (authReq.userRole === "agent") conditions.push(eq(c.userId, authReq.userId));
    if (parsed.data.contactId) conditions.push(eq(c.contactId, parsed.data.contactId));
    const rows = await db
      .select({
        id: c.id,
        contactId: c.contactId,
        userId: c.userId,
        direction: c.direction,
        status: c.status,
        toNumber: c.toNumber,
        startedAt: c.startedAt,
        answeredAt: c.answeredAt,
        endedAt: c.endedAt,
        durationSeconds: c.durationSeconds,
        dispositionCode: c.dispositionCode,
        notes: c.notes,
        blockedReason: c.blockedReason,
        createdAt: c.createdAt,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
      })
      .from(c)
      .leftJoin(
        contactsTable,
        and(eq(contactsTable.id, c.contactId), eq(contactsTable.orgId, authReq.orgId)),
      )
      .where(and(...conditions))
      // id breaks ties so pages never repeat or skip rows created in the same instant.
      .orderBy(desc(c.createdAt), desc(c.id))
      .limit(parsed.data.limit ?? 15)
      .offset(parsed.data.offset ?? 0);
    // `total` is the full count for the same filters, so admins can page the
    // whole audit trail (limit <= 50 per page, org scoped, agents self-scoped).
    const [{ n = 0 } = {}] = await db.select({ n: count() }).from(c).where(and(...conditions));
    res.json({ data: rows, total: Number(n), limit: parsed.data.limit ?? 15, offset: parsed.data.offset ?? 0 });
  },
);

const PatchCallBody = z
  .object({
    dispositionCode: z.enum(CALL_DISPOSITION_CODES).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => b.dispositionCode !== undefined || b.notes !== undefined, {
    message: "Provide a dispositionCode and/or notes",
  });

/**
 * POST /softphone/calls/:id/cancel — the browser abandoned the attempt before
 * Twilio claimed the session (mic denied, hung up while connecting). Frees the
 * attempt-limit / cooldown slot so an ordinary retry works. Owner or admin only;
 * a session Twilio already claimed cannot be canceled (409).
 */
router.post(
  "/softphone/calls/:id/cancel",
  requireAuth,
  requirePermission("call", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const c = callSessionsTable;
    const [row] = await db
      .select({ id: c.id, userId: c.userId })
      .from(c)
      .where(and(eq(c.id, id), eq(c.orgId, authReq.orgId)))
      .limit(1);
    const isAdmin = authReq.userRole === "agency_admin" || authReq.userRole === "super_admin";
    if (!row || (row.userId !== authReq.userId && !isAdmin)) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    const outcome = await cancelUnclaimedSession(row.id, authReq.orgId);
    // Only the first real state change is audited; an idempotent repeat is not.
    if (outcome === "already_canceled" || outcome === "blocked") {
      (req as Request & { skipAudit?: boolean }).skipAudit = true;
    }
    if (outcome === "blocked") {
      // Idempotent no-op: a blocked session was never dialable, so there is nothing to cancel.
      res.json({ id: row.id, status: "blocked" });
      return;
    }
    if (outcome === "already_used") {
      res.status(409).json({ error: "This call already reached Twilio and cannot be canceled" });
      return;
    }
    res.json({ id: row.id, status: "canceled" });
  },
);

/** PATCH /softphone/calls/:id — save disposition + notes (owner or admin only). */
router.patch(
  "/softphone/calls/:id",
  requireAuth,
  requirePermission("call", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = PatchCallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const c = callSessionsTable;
    const [row] = await db
      .select()
      .from(c)
      .where(and(eq(c.id, id), eq(c.orgId, authReq.orgId)))
      .limit(1);
    const isAdmin = authReq.userRole === "agency_admin" || authReq.userRole === "super_admin";
    // Not yours and not an admin: indistinguishable from a missing call.
    if (!row || (row.userId !== authReq.userId && !isAdmin)) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    if (row.status === "blocked") {
      res.status(409).json({ error: "A blocked call cannot be dispositioned" });
      return;
    }
    // A do-not-call opt-out is consulted for this number across EVERY org, so it
    // is only accepted for a call that provably reached and was answered by the
    // person — never for a session Twilio never claimed or nobody picked up.
    if (
      parsed.data.dispositionCode === "DO_NOT_CALL" &&
      !((row.status === "in_progress" || row.status === "completed") && row.answeredAt != null)
    ) {
      res.status(409).json({ error: "Do not call can only be recorded for a call that was answered." });
      return;
    }

    const patch: Partial<typeof c.$inferInsert> = {};
    if (parsed.data.dispositionCode !== undefined) patch.dispositionCode = parsed.data.dispositionCode;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes?.trim() || null;

    const dnc = parsed.data.dispositionCode === "DO_NOT_CALL";
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(c).set(patch).where(and(eq(c.id, row.id), eq(c.orgId, authReq.orgId))).returning();
      if (dnc) {
        // Through the shared opt-out helper: opt_outs row (idempotent) + the
        // contact's opt-out flag, so calls AND texts to this number stop.
        await recordPhoneOptOut(tx, {
          orgId: authReq.orgId,
          contactId: row.contactId,
          phone: row.toNumber,
          source: "call_disposition",
        });
        await tx.insert(auditLogTable).values({
          id: randomUUID(),
          orgId: authReq.orgId,
          userId: authReq.userId,
          userRole: authReq.userRole,
          action: "call_dnc_opt_out",
          resourceType: "call",
          resourceId: row.id,
          changes: { contactId: row.contactId, via: "call_disposition" },
        });
      }
      // Keep the contact-timeline entry in step with what was saved. (If the
      // activity does not exist yet, the status callback copies these from the row.)
      const activityMeta: Record<string, unknown> = {};
      if (patch.dispositionCode) activityMeta.disposition = patch.dispositionCode;
      // Whenever notes were explicitly provided (including cleared to null).
      if (parsed.data.notes !== undefined) activityMeta.notes = patch.notes ?? null;
      if (row.activityId && Object.keys(activityMeta).length > 0) {
        await tx
          .update(activitiesTable)
          .set({
            metadata: sql`coalesce(${activitiesTable.metadata}, '{}'::jsonb) || ${JSON.stringify(activityMeta)}::jsonb`,
          })
          .where(and(eq(activitiesTable.id, row.activityId), eq(activitiesTable.orgId, authReq.orgId)));
      }
      return u;
    });
    if (dnc) logger.info({ callSessionId: row.id }, "Call disposition recorded a do-not-call opt-out");
    res.json({
      id: updated!.id,
      status: updated!.status,
      dispositionCode: updated!.dispositionCode,
      notes: updated!.notes,
    });
  },
);

export default router;
