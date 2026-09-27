/**
 * Commission reconciliation overview (stage 2, read-only).
 *
 *   GET /commissions/reconciliation/overview
 *
 * One call for the Reconciliation page, composed entirely from data the
 * commissions pipeline already writes:
 *   - per-statement variance: the carrier's stated total vs the sum of the
 *     line items parsed from the file, plus matched / unmatched counts;
 *   - line items that could not be matched to a client or agent;
 *   - open missed-payment alerts (expected commission that never arrived).
 *
 * Gated on `commission:read` and scoped to the caller's org like every other
 * commissions route. No member ids (which can be an MBI) are returned.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  commissionStatementsTable,
  commissionLineItemsTable,
  carriersTable,
  missedPaymentAlertsTable,
  contactsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";

import {
  VARIANCE_TOLERANCE,
  displayStatementStatus,
  statementVariance,
} from "../lib/commissions/statementStatus";

const router: IRouter = Router();

const STATEMENT_LIMIT = 50;
const ITEM_LIMIT = 50;

function money(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

router.get(
  "/commissions/reconciliation/overview",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const orgId = authReq.orgId;

    // Per-statement line-item aggregates, org-scoped on both sides.
    const itemAgg = db
      .select({
        statementId: commissionLineItemsTable.statementId,
        lineItemCount: sql<number>`count(*)::int`.as("line_item_count"),
        unmatchedCount:
          sql<number>`count(*) FILTER (WHERE ${commissionLineItemsTable.matchStatus} = 'unmatched')::int`.as(
            "unmatched_count",
          ),
        lineItemTotal: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}), 0)::text`.as(
          "line_item_total",
        ),
      })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.orgId, orgId))
      .groupBy(commissionLineItemsTable.statementId)
      .as("item_agg");

    const [statementRows, [itemTotals], [statementTotals], unmatchedRows, [missedTotals], missedRows] =
      await Promise.all([
        db
          .select({
            id: commissionStatementsTable.id,
            carrierName: carriersTable.name,
            statementDate: commissionStatementsTable.statementDate,
            periodStart: commissionStatementsTable.periodStart,
            periodEnd: commissionStatementsTable.periodEnd,
            status: commissionStatementsTable.status,
            reconciledAt: commissionStatementsTable.reconciledAt,
            totalAmount: commissionStatementsTable.totalAmount,
            lineItemCount: itemAgg.lineItemCount,
            unmatchedCount: itemAgg.unmatchedCount,
            lineItemTotal: itemAgg.lineItemTotal,
          })
          .from(commissionStatementsTable)
          .leftJoin(
            carriersTable,
            and(
              eq(carriersTable.id, commissionStatementsTable.carrierId),
              eq(carriersTable.orgId, orgId),
            ),
          )
          .leftJoin(itemAgg, eq(itemAgg.statementId, commissionStatementsTable.id))
          .where(eq(commissionStatementsTable.orgId, orgId))
          .orderBy(desc(commissionStatementsTable.statementDate), desc(commissionStatementsTable.createdAt))
          .limit(STATEMENT_LIMIT),
        db
          .select({
            total: sql<number>`count(*)::int`,
            matched: sql<number>`count(*) FILTER (WHERE ${commissionLineItemsTable.matchStatus} = 'matched')::int`,
            manual: sql<number>`count(*) FILTER (WHERE ${commissionLineItemsTable.matchStatus} = 'manual')::int`,
            unmatched: sql<number>`count(*) FILTER (WHERE ${commissionLineItemsTable.matchStatus} = 'unmatched')::int`,
            unmatchedAmount: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}) FILTER (WHERE ${commissionLineItemsTable.matchStatus} = 'unmatched'), 0)::text`,
          })
          .from(commissionLineItemsTable)
          .where(eq(commissionLineItemsTable.orgId, orgId)),
        db
          .select({
            total: sql<number>`count(*)::int`,
            pending: sql<number>`count(*) FILTER (WHERE ${commissionStatementsTable.status} = 'pending')::int`,
            parsed: sql<number>`count(*) FILTER (WHERE ${commissionStatementsTable.status} = 'parsed')::int`,
            reconciled: sql<number>`count(*) FILTER (WHERE ${commissionStatementsTable.status} = 'reconciled')::int`,
            // Reconciled statements whose parsed lines don't add up to the
            // carrier total. Subtracted from `reconciled` below so the page
            // never counts them as cleanly reconciled.
            // Column refs are written table-qualified on purpose: drizzle
            // renders unqualified names in a single-table select, and an
            // unqualified "id" inside the subquery would bind to li.id.
            reconciledWithVariance: sql<number>`count(*) FILTER (WHERE commission_statements.status = 'reconciled' AND commission_statements.total_amount IS NOT NULL AND EXISTS (
              SELECT 1 FROM commission_line_items li
              WHERE li.statement_id = commission_statements.id AND li.org_id = ${orgId}
              HAVING count(*) > 0 AND abs(commission_statements.total_amount - coalesce(sum(li.commission_amount), 0)) >= ${VARIANCE_TOLERANCE}
            ))::int`,
          })
          .from(commissionStatementsTable)
          .where(eq(commissionStatementsTable.orgId, orgId)),
        db
          .select({
            id: commissionLineItemsTable.id,
            statementId: commissionLineItemsTable.statementId,
            carrierName: carriersTable.name,
            policyNumber: commissionLineItemsTable.policyNumber,
            planType: commissionLineItemsTable.planType,
            periodStart: commissionLineItemsTable.periodStart,
            commissionAmount: commissionLineItemsTable.commissionAmount,
            type: commissionLineItemsTable.type,
          })
          .from(commissionLineItemsTable)
          .innerJoin(
            commissionStatementsTable,
            and(
              eq(commissionStatementsTable.id, commissionLineItemsTable.statementId),
              eq(commissionStatementsTable.orgId, orgId),
            ),
          )
          .leftJoin(
            carriersTable,
            and(
              eq(carriersTable.id, commissionStatementsTable.carrierId),
              eq(carriersTable.orgId, orgId),
            ),
          )
          .where(
            and(
              eq(commissionLineItemsTable.orgId, orgId),
              eq(commissionLineItemsTable.matchStatus, "unmatched"),
            ),
          )
          .orderBy(desc(commissionLineItemsTable.createdAt))
          .limit(ITEM_LIMIT),
        db
          .select({
            open: sql<number>`count(*)::int`,
            expected: sql<string>`coalesce(sum(${missedPaymentAlertsTable.expectedAmount}), 0)::text`,
          })
          .from(missedPaymentAlertsTable)
          .where(and(eq(missedPaymentAlertsTable.orgId, orgId), isNull(missedPaymentAlertsTable.resolvedAt))),
        db
          .select({
            id: missedPaymentAlertsTable.id,
            contactId: missedPaymentAlertsTable.contactId,
            contactFirstName: contactsTable.firstName,
            contactLastName: contactsTable.lastName,
            policyNumber: missedPaymentAlertsTable.policyNumber,
            expectedAmount: missedPaymentAlertsTable.expectedAmount,
            expectedPeriod: missedPaymentAlertsTable.expectedPeriod,
            detectedAt: missedPaymentAlertsTable.detectedAt,
          })
          .from(missedPaymentAlertsTable)
          .leftJoin(
            contactsTable,
            and(
              eq(contactsTable.id, missedPaymentAlertsTable.contactId),
              eq(contactsTable.orgId, orgId),
            ),
          )
          .where(and(eq(missedPaymentAlertsTable.orgId, orgId), isNull(missedPaymentAlertsTable.resolvedAt)))
          .orderBy(desc(missedPaymentAlertsTable.detectedAt))
          .limit(ITEM_LIMIT),
      ]);

    const statements = statementRows.map((s) => {
      const lineItemCount = Number(s.lineItemCount ?? 0);
      const lineItemTotal = money(s.lineItemTotal);
      // Variance only means something when the carrier stated a total AND
      // we parsed at least one line to compare it with. Shared with the
      // statement list/detail (lib/commissions/statementStatus.ts).
      const variance = statementVariance(s.totalAmount, lineItemTotal, lineItemCount);
      return {
        id: s.id,
        carrierName: s.carrierName ?? null,
        statementDate: s.statementDate,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        status: s.status,
        displayStatus: displayStatementStatus(s.status, variance),
        reconciledAt: s.reconciledAt ?? null,
        totalAmount: s.totalAmount != null ? money(s.totalAmount) : null,
        lineItemCount,
        unmatchedCount: Number(s.unmatchedCount ?? 0),
        lineItemTotal,
        variance,
      };
    });

    const withVariance = statements.filter((s) => s.variance != null && Math.abs(s.variance) >= 0.01);
    const now = Date.now();

    res.json({
      statements,
      totals: {
        statements: Number(statementTotals?.total ?? 0),
        statementsPending: Number(statementTotals?.pending ?? 0),
        statementsParsed: Number(statementTotals?.parsed ?? 0),
        // Cleanly reconciled only; ones with a variance are counted apart.
        statementsReconciled:
          Number(statementTotals?.reconciled ?? 0) - Number(statementTotals?.reconciledWithVariance ?? 0),
        statementsReconciledWithVariance: Number(statementTotals?.reconciledWithVariance ?? 0),
        lineItems: Number(itemTotals?.total ?? 0),
        matched: Number(itemTotals?.matched ?? 0),
        manual: Number(itemTotals?.manual ?? 0),
        unmatched: Number(itemTotals?.unmatched ?? 0),
        unmatchedAmount: money(itemTotals?.unmatchedAmount),
        // Among the most recent statements shown above.
        statementsWithVariance: withVariance.length,
        varianceAmount: money(withVariance.reduce((sum, s) => sum + Math.abs(s.variance ?? 0), 0)),
        openMissedPayments: Number(missedTotals?.open ?? 0),
        missedExpectedAmount: money(missedTotals?.expected),
      },
      unmatchedItems: unmatchedRows.map((r) => ({
        ...r,
        commissionAmount: money(r.commissionAmount),
      })),
      missedPayments: missedRows.map((m) => ({
        id: m.id,
        contactId: m.contactId,
        contactName:
          m.contactFirstName || m.contactLastName
            ? `${m.contactFirstName ?? ""} ${m.contactLastName ?? ""}`.trim()
            : null,
        policyNumber: m.policyNumber,
        expectedAmount: m.expectedAmount != null ? money(m.expectedAmount) : null,
        expectedPeriod: m.expectedPeriod,
        detectedAt: m.detectedAt,
        daysOpen: Math.max(0, Math.floor((now - new Date(m.detectedAt).getTime()) / 86_400_000)),
      })),
      asOf: new Date().toISOString(),
    });
  },
);

export default router;
