/**
 * Appointment reminder sweep (stage2/calendar-branding).
 *
 * Runs every 15 minutes (lib/jobs.ts). For each confirmed/pending appointment
 * starting within the next 24 hours that has a contact and has not been
 * reminded yet, it sends ONE reminder through the existing senders
 * (SEND_SCHEDULED_SMS / SEND_SCHEDULED_EMAIL jobs). Channel choice uses the
 * ONE consumer outreach gate (lib/compliance/consumerOutreach.ts, automated),
 * and the jobs carry the same `consumer` context so the gate re-checks at
 * send time (lib/compliance/consumerDelivery.ts):
 *
 *   - opt-outs: contact flags, do-not-contact, and the `opt_outs` lists
 *     (phone matched on its last 10 digits);
 *   - SMS: TCPA consent when the org requires it, and the recipient's legal
 *     texting window (federal 8am–9pm plus narrower state windows). A text is
 *     never sent outside that window: the reminder is deferred to a later
 *     sweep, unless the appointment is under 2 hours away, in which case
 *     only email goes;
 *   - email: carries the shared unsubscribe link (CAN-SPAM).
 *
 * Idempotency: the reminder is claimed with a conditional
 * `UPDATE … SET reminder_sent_at = now() WHERE reminder_sent_at IS NULL`, so
 * overlapping sweeps (or a pg-boss retry) never double-send. Rescheduling an
 * appointment clears the claim (routes/appointments.ts).
 *
 * Content is deliberately PHI-free: no notes, no plan or health details —
 * just who, when and where.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import {
  db,
  agentsTable,
  appointmentsTable,
  contactsTable,
  orgBrandingTable,
  organizationsTable,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { resolveTimezone } from "../lib/dialer/preclearance";
import { logger } from "../lib/logger";
import {
  evaluateConsumerEmail,
  evaluateConsumerSms,
  type ConsumerContext,
} from "../lib/compliance/consumerOutreach";

export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
/** Inside this window a deferred SMS would arrive too late — send email only. */
export const SMS_DEFER_LIMIT_MS = 2 * 60 * 60 * 1000;
const BATCH = 500;

export interface ReminderSweepSummary {
  considered: number;
  sent: number;
  deferred: number;
  smsQueued: number;
  emailQueued: number;
  noChannel: number;
}

const LOCATION_LABEL: Record<string, string> = {
  office: "at our office",
  phone: "by phone",
  video: "by video call",
  home: "at your home",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatWhen(at: Date, timeZone: string | null): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return fmt.format(at);
}

export async function appointmentRemindersWorker(
  now: Date = new Date(),
): Promise<ReminderSweepSummary> {
  const summary: ReminderSweepSummary = {
    considered: 0,
    sent: 0,
    deferred: 0,
    smsQueued: 0,
    emailQueued: 0,
    noChannel: 0,
  };

  const horizon = new Date(now.getTime() + REMINDER_LEAD_MS);

  const rows = await db
    .select({
      id: appointmentsTable.id,
      orgId: appointmentsTable.orgId,
      contactId: contactsTable.id,
      startsAt: appointmentsTable.startsAt,
      locationType: appointmentsTable.locationType,
      locationDetail: appointmentsTable.locationDetail,
      meetingUrl: appointmentsTable.meetingUrl,
      contactFirstName: contactsTable.firstName,
      phone: contactsTable.phone,
      email: contactsTable.email,
      stateCode: contactsTable.stateCode,
      agentFirstName: agentsTable.firstName,
      agentLastName: agentsTable.lastName,
      orgName: organizationsTable.name,
      productName: orgBrandingTable.productName,
      emailFromName: orgBrandingTable.emailFromName,
    })
    .from(appointmentsTable)
    .innerJoin(
      contactsTable,
      and(
        eq(contactsTable.id, appointmentsTable.contactId),
        eq(contactsTable.orgId, appointmentsTable.orgId),
        isNull(contactsTable.deletedAt),
      ),
    )
    .innerJoin(organizationsTable, eq(organizationsTable.id, appointmentsTable.orgId))
    .leftJoin(orgBrandingTable, eq(orgBrandingTable.orgId, appointmentsTable.orgId))
    .leftJoin(
      agentsTable,
      and(
        eq(agentsTable.id, appointmentsTable.agentId),
        eq(agentsTable.orgId, appointmentsTable.orgId),
      ),
    )
    .where(
      and(
        inArray(appointmentsTable.status, ["confirmed", "pending"]),
        isNull(appointmentsTable.reminderSentAt),
        isNotNull(appointmentsTable.contactId),
        gt(appointmentsTable.startsAt, now),
        lte(appointmentsTable.startsAt, horizon),
      ),
    )
    .orderBy(appointmentsTable.startsAt)
    .limit(BATCH);

  for (const r of rows) {
    summary.considered += 1;

    // Channel decisions from the shared consumer gate, taken before the
    // claim so a blocked channel is never counted as "sent".
    const consumer: ConsumerContext = { orgId: r.orgId, contactId: r.contactId, automated: true };
    const smsDecision = await evaluateConsumerSms(consumer, now);
    const emailDecision = await evaluateConsumerEmail(consumer);
    const smsAllowed = smsDecision.action !== "block";
    const emailAllowed = emailDecision.action === "send";
    const inHours = smsDecision.action === "send";
    const msUntil = r.startsAt.getTime() - now.getTime();
    // Time zone only for rendering the appointment time.
    const tz = resolveTimezone(r.stateCode ?? undefined, undefined);

    if (smsAllowed && !inHours && msUntil > SMS_DEFER_LIMIT_MS) {
      // Wait for the texting window rather than text at night.
      summary.deferred += 1;
      continue;
    }

    const sendSms = smsAllowed && inHours;
    const sendEmail = emailAllowed;

    // Claim first; only the sweep whose UPDATE wins sends anything.
    const claimed = await db
      .update(appointmentsTable)
      .set({ reminderSentAt: now })
      .where(
        and(
          eq(appointmentsTable.id, r.id),
          eq(appointmentsTable.orgId, r.orgId),
          isNull(appointmentsTable.reminderSentAt),
        ),
      )
      .returning({ id: appointmentsTable.id });
    if (claimed.length === 0) continue;

    if (!sendSms && !sendEmail) {
      summary.noChannel += 1;
      logger.info(
        { appointmentId: r.id, orgId: r.orgId },
        "Appointment reminder skipped — no permitted channel (opt-out, STOP list, consent, texting hours or missing contact details)",
      );
      continue;
    }

    const brand = r.productName?.trim() || r.orgName;
    const when = formatWhen(r.startsAt, tz);
    const withWhom =
      r.agentFirstName ? ` with ${r.agentFirstName}${r.agentLastName ? ` ${r.agentLastName}` : ""}` : "";
    const where = LOCATION_LABEL[r.locationType] ?? "";
    const link = r.locationType === "video" && r.meetingUrl ? ` Join: ${r.meetingUrl}` : "";

    // The claim was taken before enqueueing. If an enqueue throws, release it
    // (only the claim this sweep made — matched on the exact timestamp we
    // wrote) so the next sweep retries. If one channel was already queued the
    // claim is kept: re-running would send that channel twice.
    let enqueued = 0;
    try {
      if (sendSms) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, {
          to: r.phone!,
          body: `${brand}: reminder of your appointment${withWhom} on ${when} ${where}.${link} Reply STOP to opt out.`,
          consumer,
        });
        summary.smsQueued += 1;
        enqueued += 1;
      }
      if (sendEmail) {
        const detail =
          r.locationType === "video" && r.meetingUrl
            ? `<p>Join link: <a href="${escapeHtml(r.meetingUrl)}">${escapeHtml(r.meetingUrl)}</a></p>`
            : r.locationDetail
              ? `<p>Where: ${escapeHtml(r.locationDetail)}</p>`
              : "";
        await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
          to: r.email!,
          subject: `Reminder: your appointment on ${when}`,
          html:
            `<p>Hi ${escapeHtml(r.contactFirstName)},</p>` +
            `<p>This is a reminder of your appointment${escapeHtml(withWhom)} on <strong>${escapeHtml(when)}</strong> ${escapeHtml(where)}.</p>` +
            detail +
            `<p>If you need to reschedule, just reply to this email.</p>` +
            `<p>— ${escapeHtml(brand)}</p>`,
          tags: { type: "appointment_reminder" },
          ...(r.emailFromName ? { fromName: r.emailFromName } : {}),
          consumer,
        });
        summary.emailQueued += 1;
        enqueued += 1;
      }
    } catch (err) {
      if (enqueued === 0) {
        await db
          .update(appointmentsTable)
          .set({ reminderSentAt: null })
          .where(
            and(
              eq(appointmentsTable.id, r.id),
              eq(appointmentsTable.orgId, r.orgId),
              eq(appointmentsTable.reminderSentAt, now),
            ),
          );
      }
      logger.error(
        { err, appointmentId: r.id, orgId: r.orgId, released: enqueued === 0 },
        "Appointment reminder enqueue failed",
      );
      continue;
    }
    summary.sent += 1;
  }

  logger.info({ ...summary }, "Appointment reminder sweep complete");
  return summary;
}
