/**
 * Commission Missed-Payment Check (nightly cron).
 *
 * For every ACTIVE, EFFECTUATED enrollment — not every enrolled contact. A
 * carrier pays on an enrollment, so that is the unit a missing payment is
 * missing against, and a beneficiary holding an MA plan plus a standalone PDP
 * has two commission streams that must be checked independently.
 *
 *   1. Find the commission_schedule governing that enrollment's carrier +
 *      plan_type, at or before the enrollment's own plan year (not merely the
 *      newest contract year on file).
 *   2. Estimate expected commission for the previous calendar month using
 *      premium × renewal_pct × hierarchy split.
 *   3. If no commission_line_item matches THAT POLICY for the period within
 *      the last 60 days, insert a missed_payment_alerts row. Matching narrows
 *      by policy number when the enrollment has one, and otherwise by plan
 *      type: matching on contact alone would let a paid MA line item mask a
 *      missing PDP payment for the same beneficiary.
 *   4. Fire the `commission_missed` automation trigger when a new alert is
 *      inserted.
 *
 * Alerts are keyed per policy per period, so the two streams above produce two
 * independent alerts rather than colliding on one row.
 *
 * Runs daily at 02:30 UTC.
 */

import { and, eq, gte, isNull, lte, notInArray, or, sql } from "drizzle-orm";
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
        // Restores a filter the contact-based query had and the enrollment
        // rewrite dropped. The 0040 backfill marks coverage active from the
        // flattened columns regardless of the contact's own status, so without
        // this a `lost` or `do_not_contact` beneficiary starts generating
        // missed-payment alerts on the first cron run after deploy.
        notInArray(contactsTable.status, ["lost", "do_not_contact"]),
        orgFilter,
      ),
    );

  // How many active enrollments each contact holds. This decides whether the
  // "line item records neither policy number nor plan type" tolerance below is
  // safe: with one enrollment an unattributable line item can only belong to
  // that enrollment, but with two it would satisfy BOTH and silence the alert
  // for whichever stream is genuinely unpaid.
  const enrollmentsPerContact = new Map<string, number>();
  for (const e of activeEnrollments) {
    enrollmentsPerContact.set(
      e.contactId,
      (enrollmentsPerContact.get(e.contactId) ?? 0) + 1,
    );
  }

  let alertsInserted = 0;

  for (const enrollment of activeEnrollments) {
    if (!enrollment.carrierId) continue;

    // Does a recent line item cover THIS POLICY for the period?
    //
    // Narrowing past `contactId` matters: a beneficiary with an MA plan and a
    // standalone PDP has two commission streams, and matching on contact alone
    // means one paid line item silences the alert for both — the exact failure
    // this worker was repointed at enrollments to fix.
    //
    // Prefer the policy number when the enrollment carries one (carriers key
    // their statements by it), otherwise fall back to plan type, which still
    // separates the MA stream from the PDP stream.
    //
    // The tolerance for line items that record NEITHER is scoped to
    // single-enrollment contacts, and that scoping is the whole point. An
    // earlier version allowed `IS NULL` unconditionally so a sparse statement
    // could not manufacture false alerts — but on a dual-enrolled beneficiary
    // one unattributable line item then satisfied every enrollment, producing
    // zero alerts where two were owed. That is the precise "one paid stream
    // silences the other" failure this worker was rewritten to fix, reopened
    // by the safeguard against the opposite error.
    //
    // Where the two risks collide, the missed alert is the worse one: an extra
    // alert is a minute of an agent's attention, a missed one is unpaid
    // commission nobody goes looking for. So with more than one active
    // enrollment we demand positive attribution.
    const ambiguous = (enrollmentsPerContact.get(enrollment.contactId) ?? 1) > 1;

    const policyMatch = enrollment.policyNumber
      ? or(
          eq(commissionLineItemsTable.policyNumber, enrollment.policyNumber),
          eq(commissionLineItemsTable.memberId, enrollment.policyNumber),
          ...(ambiguous ? [] : [isNull(commissionLineItemsTable.policyNumber)]),
        )
      : or(
          eq(commissionLineItemsTable.planType, enrollment.planType),
          ...(ambiguous ? [] : [isNull(commissionLineItemsTable.planType)]),
        );

    const [hasLineItem] = await db
      .select({ id: commissionLineItemsTable.id })
      .from(commissionLineItemsTable)
      .where(
        and(
          eq(commissionLineItemsTable.orgId, enrollment.orgId),
          eq(commissionLineItemsTable.contactId, enrollment.contactId),
          policyMatch,
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
