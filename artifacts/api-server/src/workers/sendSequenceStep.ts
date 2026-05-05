/**
 * Send Sequence Step Worker.
 *
 * Executes a single outreach sequence step for a contact enrollment.
 * After execution, advances the enrollment pointer and schedules the next step
 * according to the step's configured delay.
 *
 * Step types:
 *   email — enqueue transactional email via Resend
 *   sms   — enqueue transactional SMS via Twilio
 *   task  — create a task instance on the assigned agent
 *   wait  — no-op; only advances the pointer (pure delay step)
 */

import { and, eq, gt } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  sequencesTable,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
  contactsTable,
  taskInstancesTable,
} from "@workspace/db";
import { type SendSequenceStepPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";

function delayToMs(value: number, unit: string): number {
  switch (unit) {
    case "minutes":
      return value * 60_000;
    case "hours":
      return value * 3_600_000;
    case "days":
    default:
      return value * 86_400_000;
  }
}

export async function sendSequenceStepWorker(
  data: SendSequenceStepPayload,
): Promise<void> {
  const { sequenceId, contactId, stepIndex, channel } = data;

  // Load enrollment
  const [enrollment] = await db
    .select()
    .from(sequenceEnrollmentsTable)
    .where(
      and(
        eq(sequenceEnrollmentsTable.sequenceId, sequenceId),
        eq(sequenceEnrollmentsTable.contactId, contactId),
        eq(sequenceEnrollmentsTable.status, "active"),
      ),
    )
    .limit(1);

  if (!enrollment) {
    logger.warn({ sequenceId, contactId }, "Sequence enrollment not found or inactive");
    return;
  }

  // Load sequence steps sorted by orderIndex
  const steps = await db
    .select()
    .from(sequenceStepsTable)
    .where(eq(sequenceStepsTable.sequenceId, sequenceId))
    .orderBy(sequenceStepsTable.orderIndex);

  const step = steps[stepIndex];
  if (!step) {
    // No more steps — mark enrollment complete
    await db
      .update(sequenceEnrollmentsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    logger.info({ sequenceId, contactId }, "Sequence enrollment completed — no more steps");
    return;
  }

  // Load contact for contact-specific fields
  const [contact] = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.id, contactId))
    .limit(1);

  if (!contact) {
    logger.warn({ contactId }, "Contact not found for sequence step");
    return;
  }

  const cfg = (step.config ?? {}) as Record<string, unknown>;
  const contactName = `${contact.firstName} ${contact.lastName}`.trim();

  // Execute step
  switch (step.stepType) {
    case "email": {
      const to = contact.email;
      if (!to) {
        logger.warn({ contactId, stepIndex }, "Contact has no email — skipping email step");
        break;
      }
      const subject = String(cfg.subject ?? "");
      const html = String(cfg.html ?? cfg.body ?? `Hello ${contactName}`);
      await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, { to, subject, html });
      logger.info({ contactId, stepIndex }, "Sequence email step enqueued");
      break;
    }

    case "sms": {
      const to = contact.phone;
      if (!to || contact.optOutSms) {
        logger.warn(
          { contactId, stepIndex, optOut: contact.optOutSms },
          "Contact has no phone or opted out — skipping SMS step",
        );
        break;
      }
      const body = String(cfg.body ?? `Hi ${contactName}, this is a message from your Medicare advisor.`);
      await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, { to, body });
      logger.info({ contactId, stepIndex }, "Sequence SMS step enqueued");
      break;
    }

    case "task": {
      const title = String(cfg.title ?? `Follow up with ${contactName}`);
      await db.insert(taskInstancesTable).values({
        id: randomUUID(),
        orgId: contact.orgId,
        templateId: null,
        agentId: contact.assignedAgentId ?? null,
        title,
        description: String(cfg.description ?? ""),
        status: "open",
        priority: (String(cfg.priority ?? "medium")) as "low" | "medium" | "high" | "urgent",
        dueDate: cfg.dueDays
          ? new Date(Date.now() + Number(cfg.dueDays) * 86_400_000)
          : null,
      });
      logger.info({ contactId, stepIndex }, "Sequence task step created");
      break;
    }

    case "wait":
    default:
      // Pure delay — just advance pointer
      logger.debug({ contactId, stepIndex }, "Sequence wait step — advancing pointer");
      break;
  }

  // Advance enrollment to next step
  const nextIndex = stepIndex + 1;
  const nextStep = steps[nextIndex];

  if (!nextStep) {
    await db
      .update(sequenceEnrollmentsTable)
      .set({ status: "completed", completedAt: new Date(), nextStepIndex: nextIndex })
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    logger.info({ sequenceId, contactId }, "Sequence enrollment completed");
    return;
  }

  const delayMs = delayToMs(nextStep.delayValue ?? 0, nextStep.delayUnit ?? "days");
  const nextStepAt = new Date(Date.now() + delayMs);

  await db
    .update(sequenceEnrollmentsTable)
    .set({ nextStepIndex: nextIndex, nextStepAt })
    .where(eq(sequenceEnrollmentsTable.id, enrollment.id));

  // Schedule the next step
  await enqueue(
    JOB_NAMES.SEND_SEQUENCE_STEP,
    {
      sequenceId,
      contactId,
      stepIndex: nextIndex,
      channel: (nextStep.stepType === "sms" || nextStep.stepType === "email"
        ? nextStep.stepType
        : channel) as "email" | "sms",
    },
    { startAfter: nextStepAt },
  );

  logger.info(
    { sequenceId, contactId, nextIndex, nextStepAt },
    "Next sequence step scheduled",
  );
}
