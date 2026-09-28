/**
 * Softphone desk (read-only). Mediflow has no browser calling yet — these
 * endpoints power the lead screen-pop around the dial pad so an agent can see
 * who a number belongs to and whether it is OK to call them right now.
 *
 *   GET /softphone/lookup?phone=...        — contacts whose phone matches
 *   GET /softphone/precheck?contactId=...  — "OK to call?" using the real
 *                                            dialer preclearance rules
 *   GET /softphone/recent-calls            — latest call_log activities
 *   GET /softphone/dispositions            — the disposition categories the
 *                                            post-call parser also uses
 *
 * Nothing here writes, places a call, or issues a dial ticket: the
 * masterBRIDGE issuance path (lib/dialer/issuance.ts `issueTicket`) is left
 * untouched on purpose. Calls are logged through the existing
 * `POST /contacts/:id/activities` (type `call_log`).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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

const router: IRouter = Router();

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

const DISPOSITION_LABELS: Record<(typeof SUGGESTED_DISPOSITION_CATEGORIES)[number], string> = {
  POSITIVE: "Interested / moving forward",
  NEUTRAL: "Spoke — no decision",
  NEGATIVE: "Not interested",
  COMPLIANCE: "Compliance concern",
  FOLLOW_UP: "Call back / follow up",
  UNKNOWN: "No answer / unknown",
};

router.get(
  "/softphone/dispositions",
  requireAuth,
  requirePermission("contact", "read"),
  (_req: Request, res: Response): void => {
    res.json({
      data: SUGGESTED_DISPOSITION_CATEGORIES.map((code) => ({
        code,
        label: DISPOSITION_LABELS[code],
      })),
    });
  },
);

export default router;
