/**
 * Chargeback / clawback exposure report (read-only).
 *
 * When a beneficiary disenrolls early, the carrier claws back the commission it
 * already paid — booked on the statement as a `chargeback` line item (a
 * negative commission). Clawbacks are real lost revenue and a leading
 * indicator of a retention or a bad-fit-sale problem, so the agency needs them
 * surfaced: how much has been clawed back, the trend, and which writing agents
 * carry the most exposure.
 *
 * This reads only existing data (`commission_line_items` with type
 * 'chargeback', already classified by the statement parser) — no schema change.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, gte, ne, sql, desc } from "drizzle-orm";
import {
  db,
  commissionLineItemsTable,
  agentsTable,
  contactsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

/** Default look-back window (days) for the exposure view. */
const DEFAULT_WINDOW_DAYS = 365;
const MAX_WINDOW_DAYS = 1825; // 5 years

function windowStart(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (period_start is a DATE)
}

function parseDays(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(n, MAX_WINDOW_DAYS);
}

// GET /clawbacks/summary[?days=365] — exposure totals + per-agent breakdown.
router.get(
  "/clawbacks/summary",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const days = parseDays(req.query.days as string | undefined);
    const since = windowStart(days);

    const inWindow = and(
      eq(commissionLineItemsTable.orgId, authReq.orgId),
      gte(commissionLineItemsTable.periodStart, since),
    );

    const [chargebackAgg, grossAgg, byAgentRows] = await Promise.all([
      // Total clawed back (chargeback amounts are negative; abs() the sum).
      db
        .select({
          count: sql<number>`count(*)`,
          total: sql<string>`coalesce(abs(sum(${commissionLineItemsTable.commissionAmount})), 0)`,
        })
        .from(commissionLineItemsTable)
        .where(and(inWindow, eq(commissionLineItemsTable.type, "chargeback"))),
      // Gross (non-chargeback) commission booked in the window, for the rate.
      db
        .select({
          total: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}), 0)`,
        })
        .from(commissionLineItemsTable)
        .where(and(inWindow, ne(commissionLineItemsTable.type, "chargeback"))),
      // Per writing-agent clawback exposure.
      db
        .select({
          writingAgentId: commissionLineItemsTable.writingAgentId,
          agentFirstName: agentsTable.firstName,
          agentLastName: agentsTable.lastName,
          count: sql<number>`count(*)`,
          total: sql<string>`coalesce(abs(sum(${commissionLineItemsTable.commissionAmount})), 0)`,
        })
        .from(commissionLineItemsTable)
        .leftJoin(agentsTable, eq(commissionLineItemsTable.writingAgentId, agentsTable.id))
        .where(and(inWindow, eq(commissionLineItemsTable.type, "chargeback")))
        .groupBy(
          commissionLineItemsTable.writingAgentId,
          agentsTable.firstName,
          agentsTable.lastName,
        )
        .orderBy(desc(sql`abs(sum(${commissionLineItemsTable.commissionAmount}))`))
        .limit(200),
    ]);

    const clawbackTotal = Number(chargebackAgg[0]?.total ?? 0);
    const grossTotal = Number(grossAgg[0]?.total ?? 0);

    res.json({
      windowDays: days,
      since,
      chargebackCount: Number(chargebackAgg[0]?.count ?? 0),
      clawbackTotal,
      grossCommission: grossTotal,
      // Share of gross commission lost to clawbacks (0 when no gross).
      clawbackRate: grossTotal > 0 ? clawbackTotal / grossTotal : 0,
      byAgent: byAgentRows.map((r) => ({
        writingAgentId: r.writingAgentId,
        agentName:
          r.agentFirstName || r.agentLastName
            ? `${r.agentFirstName ?? ""} ${r.agentLastName ?? ""}`.trim()
            : "Unassigned",
        count: Number(r.count),
        total: Number(r.total),
      })),
    });
  },
);

// GET /clawbacks[?days=365] — the chargeback line items themselves.
router.get(
  "/clawbacks",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const days = parseDays(req.query.days as string | undefined);
    const since = windowStart(days);

    const rows = await db
      .select({
        item: commissionLineItemsTable,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
      })
      .from(commissionLineItemsTable)
      .leftJoin(agentsTable, eq(commissionLineItemsTable.writingAgentId, agentsTable.id))
      .leftJoin(contactsTable, eq(commissionLineItemsTable.contactId, contactsTable.id))
      .where(
        and(
          eq(commissionLineItemsTable.orgId, authReq.orgId),
          eq(commissionLineItemsTable.type, "chargeback"),
          gte(commissionLineItemsTable.periodStart, since),
        ),
      )
      .orderBy(desc(commissionLineItemsTable.periodStart))
      .limit(500);
    res.json(rows);
  },
);

export default router;
