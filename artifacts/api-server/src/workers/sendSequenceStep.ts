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
 *
 * Step identity is by stable `step.id`, not by positional index in the
 * sorted-by-order_index step list. An operator deleting / reordering /
 * inserting steps on a sequence with in-flight enrollments used to
 * silently shift every enrollment's pointer to a DIFFERENT logical step
 * — wrong content fired. Now:
 *   - The enrollment carries `nextStepId`.
 *   - The job payload carries `stepId`; for legacy in-flight jobs whose
 *     payload only has `stepIndex`, we fall back to a positional lookup
 *     for a single deploy cycle (then this branch can go).
 *   - On step deletion, the FK SET NULLs `nextStepId`. The worker
 *     detects the null and gracefully completes the enrollment with a
 *     note instead of executing the wrong step.
 *
 * The execution ledger (`sequence_step_executions`) keeps its
 * `(enrollmentId, stepIndex)` PK from PR #76 — it's a per-attempt
 * idempotency key, not a step identity, so it doesn't need to migrate
 * to step IDs. We continue to claim that slot using the positional
 * index of the resolved step in its sequence's ordered step list.
 */

import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
  sequenceStepExecutionsTable,
  contactsTable,
  taskInstancesTable,
  type SequenceStep,
} from "@workspace/db";
import { type SendSequenceStepPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { sequenceEmailCompliance } from "../lib/campaigns/service";

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
  const { sequenceId, contactId, channel } = data;

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

  // Load all sequence steps sorted by orderIndex once. We need the full
  // list to (a) resolve the target step's positional index for the
  // idempotency ledger and (b) find the next step in order after this
  // one runs.
  const steps = await db
    .select()
    .from(sequenceStepsTable)
    .where(eq(sequenceStepsTable.sequenceId, sequenceId))
    .orderBy(sequenceStepsTable.orderIndex);

  // ---- Resolve target step by stable ID, with legacy fallback. -----------
  //
  // Resolution priority:
  //   1) `payload.stepId` (authoritative when present — new enqueues
  //      always set it). This is the step the job was scheduled for.
  //   2) `payload.stepIndex` against the positional step list. ONE-
  //      RELEASE back-compat for pg-boss jobs enqueued by the
  //      pre-migration worker.
  //   3) `enrollment.nextStepId` if neither is present (e.g. a worker
  //      kicked off by something other than an explicit enqueue).
  //
  // The payload is preferred over the enrollment because pg-boss
  // retries carry the ORIGINAL payload — and a retry must target the
  // same step it originally targeted, even if a prior successful
  // attempt has since advanced the enrollment pointer. The ledger
  // (sequence_step_executions) suppresses any duplicate side effect.
  //
  // If the targeted step does not exist (operator deleted it
  // mid-flight; FK SET NULL nulled the enrollment pointer out, or the
  // payload references a now-missing id), gracefully complete the
  // enrollment rather than silently running a wrong-step.
  const enrollmentNextStepId = (enrollment as { nextStepId?: string | null })
    .nextStepId;
  const payloadStepId = data.stepId;
  const payloadStepIndex = data.stepIndex;

  let step: SequenceStep | undefined;
  let resolvedStepIndex: number | undefined;
  let targetedStepMissing = false;
  let resolutionPath: "byPayloadId" | "byPayloadIndex" | "byEnrollmentId" | "none" = "none";

  if (payloadStepId) {
    const idx = steps.findIndex((s) => s.id === payloadStepId);
    if (idx !== -1) {
      step = steps[idx];
      resolvedStepIndex = idx;
      resolutionPath = "byPayloadId";
    } else {
      // The payload pointed at a step that no longer exists — operator
      // deleted it. Treat as "step vanished".
      targetedStepMissing = true;
    }
  } else if (typeof payloadStepIndex === "number") {
    // Legacy back-compat: positional lookup for pg-boss jobs enqueued
    // by the pre-migration worker. The first run through this path
    // will backfill enrollment.nextStepId from the step that's
    // currently at that position, so subsequent enqueues / advances
    // take the stable-id path.
    const candidate = steps[payloadStepIndex];
    if (candidate) {
      step = candidate;
      resolvedStepIndex = payloadStepIndex;
      resolutionPath = "byPayloadIndex";
      if (!enrollmentNextStepId) {
        logger.info(
          { sequenceId, contactId, stepIndex: payloadStepIndex, stepId: candidate.id },
          "Sequence step resolved via legacy positional payload — backfilling nextStepId",
        );
        await db
          .update(sequenceEnrollmentsTable)
          .set({ nextStepId: candidate.id })
          .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
      }
    }
    // No `else` here: an out-of-range positional payload on a sequence
    // that's had steps deleted is indistinguishable from a stale
    // payload pointing past the end of an already-completed
    // enrollment. Fall through to the "no pointer" handler.
  } else if (enrollmentNextStepId) {
    const idx = steps.findIndex((s) => s.id === enrollmentNextStepId);
    if (idx !== -1) {
      step = steps[idx];
      resolvedStepIndex = idx;
      resolutionPath = "byEnrollmentId";
    } else {
      targetedStepMissing = true;
    }
  }

  if (targetedStepMissing) {
    await db
      .update(sequenceEnrollmentsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        nextStepId: null,
      })
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    logger.info(
      {
        sequenceId,
        contactId,
        enrollmentNextStepId,
        payloadStepId,
      },
      "Sequence step deleted mid-flight by operator — enrollment completed",
    );
    return;
  }

  if (!step || resolvedStepIndex === undefined) {
    // No pointer at all (e.g. sequence has zero steps, or a legacy
    // payload pointing at an out-of-range positional index). Complete
    // the enrollment so it doesn't sit forever as 'active' with a
    // dangling pointer.
    await db
      .update(sequenceEnrollmentsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        nextStepId: null,
      })
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    logger.info(
      {
        sequenceId,
        contactId,
        enrollmentNextStepId,
        payloadStepId,
        payloadStepIndex,
      },
      "Sequence enrollment completed — no more steps",
    );
    return;
  }

  // From here on `step` is the resolved step and `resolvedStepIndex`
  // is its position in the order_index-sorted list. The ledger keys
  // on (enrollment, position) per PR #76 and we keep that invariant.
  const stepIndex = resolvedStepIndex;

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

  // ---- Idempotency claim ---------------------------------------------------
  //
  // Claim the (enrollment_id, step_index) slot in the execution log BEFORE
  // firing any external side effect. If pg-boss retries this job (worker
  // crash / timeout between side effect and pointer advance), the PK
  // conflict makes this insert return zero rows and we skip the side
  // effect — preventing duplicate Twilio SMS, Resend emails, and duplicate
  // follow-up task instances.
  //
  // We claim for "wait" too, so the ledger reflects every step that
  // advanced (cheap audit trail) and so the PK is the single source of
  // truth for "did this step ever run".
  const claimed = await db
    .insert(sequenceStepExecutionsTable)
    .values({
      enrollmentId: enrollment.id,
      stepIndex,
      sideEffect: step.stepType,
    })
    .onConflictDoNothing()
    .returning({ enrollmentId: sequenceStepExecutionsTable.enrollmentId });

  if (claimed.length === 0) {
    logger.info(
      { sequenceId, contactId, stepIndex, stepId: step.id, stepType: step.stepType, resolutionPath },
      "Sequence step already executed on prior attempt — skipping side effect on retry",
    );
  } else {
    // Execute step
    switch (step.stepType) {
      case "email": {
        const to = contact.email;
        if (!to || contact.optOutEmail) {
          logger.warn(
            { contactId, stepIndex, optOut: contact.optOutEmail },
            "Contact has no email or opted out — skipping email step",
          );
          break;
        }
        const subject = String(cfg.subject ?? "");
        let html = String(cfg.html ?? cfg.body ?? `Hello ${contactName}`);
        // CAN-SPAM: when the org has a mailing address on file and the
        // unsubscribe signer is configured, append the signed unsubscribe
        // footer and List-Unsubscribe headers (see lib/campaigns). If not
        // configured this is a no-op and the email goes out as before.
        let headers: Record<string, string> | undefined;
        try {
          const compliance = await sequenceEmailCompliance(contact.orgId, contact.id);
          if (compliance) {
            html = `${html}\n${compliance.footerHtml}`;
            headers = compliance.headers;
          }
        } catch (err) {
          logger.warn({ err, contactId }, "Could not build unsubscribe footer for sequence email");
        }
        // Belt-and-braces: pg-boss singletonKey collapses any duplicate
        // job that slips past the ledger (e.g. concurrent worker on a
        // different node racing the same step). The ledger is the
        // primary guard; this is defense in depth.
        await enqueue(
          JOB_NAMES.SEND_SCHEDULED_EMAIL,
          { to, subject, html, ...(headers ? { headers } : {}) },
          { singletonKey: `seq:${enrollment.id}:${stepIndex}` },
        );
        logger.info({ contactId, stepIndex, stepId: step.id }, "Sequence email step enqueued");
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
        await enqueue(
          JOB_NAMES.SEND_SCHEDULED_SMS,
          { to, body },
          { singletonKey: `seq:${enrollment.id}:${stepIndex}` },
        );
        logger.info({ contactId, stepIndex, stepId: step.id }, "Sequence SMS step enqueued");
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
        logger.info({ contactId, stepIndex, stepId: step.id }, "Sequence task step created");
        break;
      }

      case "wait":
      default:
        // Pure delay — just advance pointer
        logger.debug({ contactId, stepIndex, stepId: step.id }, "Sequence wait step — advancing pointer");
        break;
    }
  }

  // ---- Advance enrollment to the next step. ------------------------------
  //
  // "Next" = the step in the sequence whose order_index is strictly
  // greater than the just-executed step's order_index, sorted by
  // order_index. This is robust to reordering: even if the operator
  // moved steps around mid-flight, we still find the next step
  // "after" the one we just ran, by its CURRENT order_index. (If the
  // operator also re-ordered before this point, the previous run
  // already picked the step it was pointed at by id; here we just
  // walk forward.)
  const currentOrderIndex = step.orderIndex;
  const nextStep = steps.find(
    (s) => s.orderIndex > currentOrderIndex,
  );
  const nextIndex = stepIndex + 1;

  if (!nextStep) {
    await db
      .update(sequenceEnrollmentsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        nextStepIndex: nextIndex,
        nextStepId: null,
      })
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    logger.info({ sequenceId, contactId, stepId: step.id }, "Sequence enrollment completed");
    return;
  }

  const delayMs = delayToMs(nextStep.delayValue ?? 0, nextStep.delayUnit ?? "days");
  const nextStepAt = new Date(Date.now() + delayMs);

  // Find the position of nextStep in the ordered list — used for the
  // legacy `nextStepIndex` column (kept in sync for one deploy cycle)
  // and to keep the ledger key contiguous.
  const nextStepPositional = steps.findIndex((s) => s.id === nextStep.id);

  await db
    .update(sequenceEnrollmentsTable)
    .set({
      nextStepIndex: nextStepPositional >= 0 ? nextStepPositional : nextIndex,
      nextStepId: nextStep.id,
      nextStepAt,
    })
    .where(eq(sequenceEnrollmentsTable.id, enrollment.id));

  // Schedule the next step. New jobs carry `stepId` (authoritative);
  // we keep `stepIndex` in the payload too so logs / ad-hoc inspection
  // still see a recognizable positional hint, and so workers running
  // older code during a partial deploy still find the step.
  await enqueue(
    JOB_NAMES.SEND_SEQUENCE_STEP,
    {
      sequenceId,
      contactId,
      stepId: nextStep.id,
      stepIndex: nextStepPositional >= 0 ? nextStepPositional : nextIndex,
      channel: (nextStep.stepType === "sms" || nextStep.stepType === "email"
        ? nextStep.stepType
        : channel) as "email" | "sms",
    },
    { startAfter: nextStepAt },
  );

  logger.info(
    { sequenceId, contactId, nextStepId: nextStep.id, nextStepAt },
    "Next sequence step scheduled",
  );
}
