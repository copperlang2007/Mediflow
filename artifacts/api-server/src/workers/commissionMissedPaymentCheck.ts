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

import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  commissionLineItemsTable,
  commissionSchedulesTable,
  contactsTable,
  enrollmentsTable,
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
    ? eq(enrollmentsTable.orgId, payload.orgId)
    : sql`true`;

  // Iterate enrollments, not contacts.
  //
  // Coverage used to be read off the flattened `contacts.current_*` columns,
  // which meant a beneficiary holding an MA plan AND a standalone PDP produced
  // one check instead of two — one commission stream was invisible — and last
  // year's payment was checked against whatever plan the contact happens to
  // carry today. An enrollment is the thing a carrier actually pays on, so it
  // is the thing to reconcile against.
  //
  // Only effectuated, active enrollments are in scope: a commission is not
  // genuinely owed until the carrier confirms the member is on the plan.
  const activeEnrollments = await db
    .select({
      enrollmentId: enrollmentsTable.id,
      contactId: enrollmentsTable.contactId,
      orgId: enrollmentsTable.orgId,
      carrierId: enrollmentsTable.carrierId,
      planType: enrollmentsTable.planType,
      planYear: enrollmentsTable.planYear,
      policyNumber: enrollmentsTable.policyNumber,
    })
    .from(enrollmentsTable)
    .innerJoin(contactsTable, eq(contactsTable.id, enrollmentsTable.contactId))
    .where(
      and(
        eq(enrollmentsTable.status, "active"),
        eq(enrollmentsTable.effectuated, true),
        isNull(enrollmentsTable.disenrolledDate),
        isNull(contactsTable.deletedAt),
        orgFilter,
      ),
    );

  let alertsInserted = 0;

  for (const enrollment of activeEnrollments) {
    if (!enrollment.carrierId) continue;

    // Has a recent line item for this contact within the period covered the gap?
    const [hasLineItem] = await db
      .select({ id: commissionLineItemsTable.id })
      .from(commissionLineItemsTable)
      .where(
        and(
          eq(commissionLineItemsTable.orgId, enrollment.orgId),
          eq(commissionLineItemsTable.contactId, enrollment.contactId),
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
          eq(commissionSchedulesTable.orgId, enrollment.orgId),
          eq(commissionSchedulesTable.carrierId, enrollment.carrierId),
          eq(commissionSchedulesTable.planType, enrollment.planType),
          eq(commissionSchedulesTable.status, "active"),
          // Prefer the schedule that governs the enrollment's own plan year
          // rather than whatever the newest contract year happens to be.
          lte(commissionSchedulesTable.contractYear, enrollment.planYear),
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
          orgId: enrollment.orgId,
          contactId: enrollment.contactId,
          // Was always null. That deduped correctly — migration 0005 made the
          // unique constraint NULLS NOT DISTINCT precisely so it would — but
          // it deduped per CONTACT, which is now too coarse: a beneficiary
          // holding an MA plan and a standalone PDP has two commission
          // streams, and collapsing them to one key would silently drop the
          // second alert. Keying on the policy (falling back to the
          // enrollment id, which is always present) makes it one alert per
          // policy per period.
          policyNumber: enrollment.policyNumber ?? enrollment.enrollmentId,
          expectedAmount,
          expectedPeriod: period.start,
        })
        .onConflictDoNothing()
        .returning({ id: missedPaymentAlertsTable.id });

      if (inserted.length > 0) {
        alertsInserted++;
        await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
          orgId: enrollment.orgId,
          trigger: "commission_missed",
          resourceType: "missed_payment_alert",
          resourceId: inserted[0].id,
          context: {
            contactId: enrollment.contactId,
            enrollmentId: enrollment.enrollmentId,
            expectedPeriod: period.start,
            expectedAmount,
          },
        });
      }
    } catch (err) {
      logger.warn(
        { err, contactId: enrollment.contactId, enrollmentId: enrollment.enrollmentId },
        "Failed to insert missed-payment alert",
      );
    }
  }

  logger.info({ alertsInserted, period }, "commission missed-payment check complete");
}
