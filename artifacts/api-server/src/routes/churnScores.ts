/**
 * Churn / retention risk scoring (read-only).
 *
 * Proactive retention is a core agency motion: a current member who quietly
 * disengages — no recent contact, an open complaint, an at-risk flag, a
 * first-year plan up for its first renewal — is the one most likely to switch
 * plans (or agents) at AEP. This endpoint scores every current MA/MAPD-era
 * member by disenrollment risk so the retention team can work the riskiest
 * book first, with the reasons spelled out.
 *
 * It reads only existing tables (contacts, activities, complaints,
 * retention_flags) — no schema change. The score is a transparent weighted sum
 * of signals (see `scoreMember`), capped at 100, bucketed high / medium / low.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  contactsTable,
  activitiesTable,
  complaintsTable,
  retentionFlagsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

/** Current-member statuses (someone whose plan is up for renewal). */
const MEMBER_STATUSES = ["enrolled", "retained"] as const;

/** Days of silence before inactivity counts against a member. */
const INACTIVITY_HARD_DAYS = 90;
const INACTIVITY_SOFT_DAYS = 60;

/** Risk-band thresholds on the 0–100 score. */
export const RISK_BANDS = { high: 50, medium: 25 } as const;

export interface MemberSignals {
  lastActivityAt: Date | null;
  hasOpenComplaint: boolean;
  hasAtRiskFlag: boolean;
  /** Plan year on file; first renewal is when planYear === currentYear - 1. */
  planYear: number | null;
  currentYear: number;
  now: Date;
}

export interface ChurnScore {
  score: number;
  band: "high" | "medium" | "low";
  reasons: string[];
}

/**
 * Transparent weighted risk score. Each signal adds points and a reason; the
 * total is capped at 100 and bucketed. Kept pure so it's unit-testable and the
 * UI can explain exactly why a member is flagged.
 */
export function scoreMember(s: MemberSignals): ChurnScore {
  let score = 0;
  const reasons: string[] = [];

  const daysSinceActivity =
    s.lastActivityAt === null
      ? Infinity
      : (s.now.getTime() - s.lastActivityAt.getTime()) / 86_400_000;

  if (daysSinceActivity === Infinity) {
    score += 35;
    reasons.push("No logged activity on record");
  } else if (daysSinceActivity >= INACTIVITY_HARD_DAYS) {
    score += 35;
    reasons.push(`No contact in ${Math.floor(daysSinceActivity)} days`);
  } else if (daysSinceActivity >= INACTIVITY_SOFT_DAYS) {
    score += 18;
    reasons.push(`No contact in ${Math.floor(daysSinceActivity)} days`);
  }

  if (s.hasOpenComplaint) {
    score += 25;
    reasons.push("Open complaint on file");
  }

  if (s.hasAtRiskFlag) {
    // An explicit retention-team flag is a strong signal — enough on its own
    // to land the member at least in the "medium" band.
    score += 25;
    reasons.push("Flagged at-risk by the retention team");
  }

  if (s.planYear !== null && s.planYear === s.currentYear - 1) {
    score += 15;
    reasons.push("First plan renewal this cycle");
  }

  score = Math.min(score, 100);
  const band: ChurnScore["band"] =
    score >= RISK_BANDS.high ? "high" : score >= RISK_BANDS.medium ? "medium" : "low";
  return { score, band, reasons };
}

interface MemberRow {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  currentPlanType: string | null;
  planYear: number | null;
  lastActivityAt: Date | null;
  hasOpenComplaint: boolean;
  hasAtRiskFlag: boolean;
}

/**
 * Fetch current members with their churn signals (one row per member).
 *
 * Each signal is gathered with the typed query builder and merged in memory
 * rather than via correlated subqueries: drizzle renders proper parameterized
 * SQL for `eq`/`inArray`/`groupBy`, which is both portable and avoids the
 * fragile column-correlation interpolation that some engines don't resolve.
 */
async function loadMembers(orgId: string): Promise<MemberRow[]> {
  const [members, lastActivity, openComplaints, atRiskFlags] = await Promise.all([
    db
      .select({
        contactId: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        currentPlanType: contactsTable.currentPlanType,
        planYear: contactsTable.planYear,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, orgId),
          isNull(contactsTable.deletedAt),
          inArray(contactsTable.status, [...MEMBER_STATUSES]),
        ),
      )
      .limit(2000),
    db
      .select({
        contactId: activitiesTable.contactId,
        last: sql<Date>`max(${activitiesTable.createdAt})`,
      })
      .from(activitiesTable)
      .where(eq(activitiesTable.orgId, orgId))
      .groupBy(activitiesTable.contactId),
    db
      .selectDistinct({ contactId: complaintsTable.contactId })
      .from(complaintsTable)
      .where(
        and(
          eq(complaintsTable.orgId, orgId),
          inArray(complaintsTable.status, ["open", "investigating"]),
        ),
      ),
    db
      .selectDistinct({ contactId: retentionFlagsTable.contactId })
      .from(retentionFlagsTable)
      .where(
        and(
          eq(retentionFlagsTable.orgId, orgId),
          eq(retentionFlagsTable.flagType, "at_risk"),
          isNull(retentionFlagsTable.resolvedAt),
        ),
      ),
  ]);

  const lastActivityByContact = new Map<string, Date>();
  for (const r of lastActivity) {
    if (r.contactId && r.last) lastActivityByContact.set(r.contactId, new Date(r.last));
  }
  const openComplaintContacts = new Set(
    openComplaints.map((r) => r.contactId).filter((id): id is string => id !== null),
  );
  const atRiskContacts = new Set(
    atRiskFlags.map((r) => r.contactId).filter((id): id is string => id !== null),
  );

  return members.map((m) => ({
    contactId: m.contactId,
    firstName: m.firstName,
    lastName: m.lastName,
    currentPlanType: m.currentPlanType,
    planYear: m.planYear,
    lastActivityAt: lastActivityByContact.get(m.contactId) ?? null,
    hasOpenComplaint: openComplaintContacts.has(m.contactId),
    hasAtRiskFlag: atRiskContacts.has(m.contactId),
  }));
}

function scoreRow(r: MemberRow, now: Date, currentYear: number): ChurnScore {
  return scoreMember({
    lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null,
    hasOpenComplaint: Boolean(r.hasOpenComplaint),
    hasAtRiskFlag: Boolean(r.hasAtRiskFlag),
    planYear: r.planYear,
    currentYear,
    now,
  });
}

// GET /churn/summary — risk-band counts for the header / nav badge.
router.get(
  "/churn/summary",
  requireAuth,
  requirePermission("retention_alert", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const members = await loadMembers(authReq.orgId);

    const bands = { high: 0, medium: 0, low: 0 };
    let scoreSum = 0;
    for (const r of members) {
      const s = scoreRow(r, now, currentYear);
      bands[s.band]++;
      scoreSum += s.score;
    }
    res.json({
      totalMembers: members.length,
      high: bands.high,
      medium: bands.medium,
      low: bands.low,
      averageScore: members.length > 0 ? Math.round(scoreSum / members.length) : 0,
    });
  },
);

// GET /churn/scores[?band=high|medium|low&limit=] — scored worked-list.
router.get(
  "/churn/scores",
  requireAuth,
  requirePermission("retention_alert", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const bandFilter = req.query.band as string | undefined;
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) ?? "200", 10) || 200, 1),
      500,
    );

    const members = await loadMembers(authReq.orgId);
    const scored = members
      .map((r) => {
        const s = scoreRow(r, now, currentYear);
        return {
          contactId: r.contactId,
          firstName: r.firstName,
          lastName: r.lastName,
          currentPlanType: r.currentPlanType,
          lastActivityAt: r.lastActivityAt,
          score: s.score,
          band: s.band,
          reasons: s.reasons,
        };
      })
      .filter((m) =>
        bandFilter === "high" || bandFilter === "medium" || bandFilter === "low"
          ? m.band === bandFilter
          : true,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    res.json(scored);
  },
);

export default router;
