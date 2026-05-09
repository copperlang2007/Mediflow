/**
 * Commission Missed-Payment Check (nightly cron).
 *
 * For every active enrolled contact:
 *   1. Find the applicable commission_schedule for the contact's
 *      carrier + plan_type at the contact's plan year.
 *   2. Estimate expected commission for the previous calendar month
 *      using premium × renewal_pct × hierarchy split.
 *   3. If no commission_line_item exists for that contact + period
 *      within the last 60 days, insert a missed_payment_alerts row
 *      (idempotent via UNIQUE constraint).
 *   4. Fire the `commission_missed` automation trigger when a new alert
 *      is inserted.
 *
 * Runs daily at 02:30 UTC.
 */

import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  commissionLineItemsTable,
  commissionSchedulesTable,
  contactsTable,
  missedPaymentAlertsTable,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";

export interface CommissionMissedPaymentCheckJobPayload extends Record<string, unknown> {
  orgId?: string;
}

function lastCompletedMonth(now = new Date()): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  // Previous calendar month
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 0)); // last day of prev month
  return {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
}

export async function commissionMissedPaymentCheckWorker(
  payload: CommissionMissedPaymentCheckJobPayload = {},
): Promise<void> {
  const period = lastCompletedMonth();
  const lookbackDays = 60;
  const lookbackCutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const orgFilter = payload.orgId
    ? eq(contactsTable.orgId, payload.orgId)
    : sql`true`;

  const enrolledContacts = await db
    .select({
      id: contactsTable.id,
      orgId: contactsTable.orgId,
      currentCarrierId: contactsTable.currentCarrierId,
      currentPlanType: contactsTable.currentPlanType,
      planYear: contactsTable.planYear,
    })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.status, "enrolled"),
        isNull(contactsTable.deletedAt),
        orgFilter,
      ),
    );

  let alertsInserted = 0;

  for (const contact of enrolledContacts) {
    if (!contact.currentCarrierId || !contact.currentPlanType) continue;

    // Has a recent line item for this contact within the period covered the gap?
    const [hasLineItem] = await db
      .select({ id: commissionLineItemsTable.id })
      .from(commissionLineItemsTable)
      .where(
        and(
          eq(commissionLineItemsTable.orgId, contact.orgId),
          eq(commissionLineItemsTable.contactId, contact.id),
          gte(commissionLineItemsTable.createdAt, lookbackCutoff),
          or(
            and(
              eq(commissionLineItemsTable.periodStart, period.start),
              eq(commissionLineItemsTable.periodEnd, period.end),
            ),
            // Statements may set the line-item period to nulls; fall back to created window
            and(
              isNull(commissionLineItemsTable.periodStart),
              gte(commissionLineItemsTable.createdAt, lookbackCutoff),
            ),
          ),
        ),
      )
      .limit(1);

    if (hasLineItem) continue;

    // Look up the applicable schedule to estimate expected amount
    const [schedule] = await db
      .select()
      .from(commissionSchedulesTable)
      .where(
        and(
          eq(commissionSchedulesTable.orgId, contact.orgId),
          eq(commissionSchedulesTable.carrierId, contact.currentCarrierId),
          eq(commissionSchedulesTable.planType, contact.currentPlanType),
          eq(commissionSchedulesTable.status, "active"),
        ),
      )
      .orderBy(sql`${commissionSchedulesTable.contractYear} DESC`)
      .limit(1);

    let expectedAmount: string | null = null;
    if (schedule) {
      if (schedule.flatAmount != null) {
        expectedAmount = schedule.flatAmount;
      } else if (schedule.renewalPct != null) {
        // We don't store premium on contacts; surface a row with null amount
        // when we can't compute it.
        expectedAmount = null;
      }
    }

    // Insert idempotently
    try {
      const inserted = await db
        .insert(missedPaymentAlertsTable)
        .values({
          id: randomUUID(),
          orgId: contact.orgId,
          contactId: contact.id,
          policyNumber: null,
          expectedAmount,
          expectedPeriod: period.start,
        })
        .onConflictDoNothing()
        .returning({ id: missedPaymentAlertsTable.id });

      if (inserted.length > 0) {
        alertsInserted++;
        await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
          orgId: contact.orgId,
          trigger: "commission_missed",
          resourceType: "missed_payment_alert",
          resourceId: inserted[0].id,
          context: {
            contactId: contact.id,
            expectedPeriod: period.start,
            expectedAmount,
          },
        });
      }
    } catch (err) {
      logger.warn({ err, contactId: contact.id }, "Failed to insert missed-payment alert");
    }
  }

  logger.info({ alertsInserted, period }, "commission missed-payment check complete");
}
