/**
 * Run Automation Rules Worker.
 *
 * Evaluates active automation rules matching a trigger event for an org.
 * Executes matching actions and writes a log entry for each rule run.
 *
 * Action types must match ACTION_TYPES in routes/automations.ts:
 *   create_task | send_notification | send_email | send_sms |
 *   change_contact_status | enroll_sequence | change_deal_stage |
 *   create_appointment
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  automationRulesTable,
  automationRuleLogsTable,
  contactsTable,
  dealsTable,
  leadsTable,
  notificationsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  sequenceEnrollmentsTable,
  sequenceStepsTable,
  taskInstancesTable,
  usersTable,
  agentsTable,
  appointmentsTable,
  type Contact,
} from "@workspace/db";
import {
  APPOINTMENT_LOCATION_TYPES,
  APPOINTMENT_TYPES,
  insertAppointment,
} from "../lib/appointments";
import { resolveTimezone } from "../lib/dialer/preclearance";
import { type RunAutomationRulesPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";
import { phoneMatchKey, phoneMatchKeySql } from "../lib/compliance/phone";
import {
  evaluateConditions,
  renderConfig,
  type AutomationCondition,
} from "./automationRulesEngine";
// Re-export for downstream callers that previously imported from this module.
export { evaluateCondition, evaluateConditions, renderTemplate } from "./automationRulesEngine";
export type { AutomationCondition } from "./automationRulesEngine";

interface AutomationAction {
  type:
    | "create_task"
    | "send_notification"
    | "send_email"
    | "send_sms"
    | "change_contact_status"
    | "enroll_sequence"
    | "change_deal_stage"
    | "create_appointment";
  config: Record<string, unknown>;
}

// ---- Action execution ----

/**
 * The consumer contact an action targets, when there is one: the resource
 * itself for contact triggers, or the linked contact a lead_* trigger puts in
 * its context.
 */
function consumerContactFor(
  resourceType: string,
  resourceId: string | null | undefined,
  context: Record<string, unknown>,
): string | null {
  if (resourceType === "contact" && resourceId) return resourceId;
  return typeof context.contactId === "string" ? context.contactId : null;
}

type ExplicitRecipient =
  | { kind: "internal" }
  | { kind: "consumer"; contactId: string }
  | { kind: "unknown" };

/**
 * Classify an explicit `to` from a rule's config. `to` is templated, so it can
 * resolve to a consumer's own address (`{{email}}`, `{{phone}}`): it counts as
 * an internal notification only when it belongs to this org's staff (an active
 * user or an agent). A consumer address is routed through the outreach gate as
 * that contact; anything else is not sent.
 */
async function classifyExplicitRecipient(
  orgId: string,
  channel: "email" | "sms",
  to: string,
): Promise<ExplicitRecipient> {
  if (channel === "email") {
    const address = to.trim().toLowerCase();
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.orgId, orgId), eq(usersTable.isActive, true), sql`lower(${usersTable.email}) = ${address}`))
      .limit(1);
    if (user) return { kind: "internal" };
    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.orgId, orgId), sql`lower(${agentsTable.email}) = ${address}`))
      .limit(1);
    if (agent) return { kind: "internal" };
    const [contact] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, orgId),
          sql`${contactsTable.deletedAt} IS NULL`,
          sql`lower(${contactsTable.email}) = ${address}`,
        ),
      )
      .limit(1);
    return contact ? { kind: "consumer", contactId: contact.id } : { kind: "unknown" };
  }

  const key = phoneMatchKey(to);
  if (!key) return { kind: "unknown" };
  const [agent] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, orgId), sql`${phoneMatchKeySql(agentsTable.phone)} = ${key}`))
    .limit(1);
  if (agent) return { kind: "internal" };
  const [contact] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.orgId, orgId),
        sql`${contactsTable.deletedAt} IS NULL`,
        sql`${phoneMatchKeySql(contactsTable.phone)} = ${key}`,
      ),
    )
    .limit(1);
  return contact ? { kind: "consumer", contactId: contact.id } : { kind: "unknown" };
}

async function executeAction(
  action: AutomationAction,
  {
    orgId,
    resourceType,
    resourceId,
    context,
  }: {
    orgId: string;
    resourceType: string;
    resourceId: string;
    context: Record<string, unknown>;
  },
): Promise<void> {
  // Substitute {{var}} placeholders in any string config before reading it.
  const config = renderConfig(action.config, context);

  switch (action.type) {
    case "create_task": {
      const {
        title,
        description,
        agentId: taskAgentId,
        contactId: taskContactId,
        dueDate: taskDueDate,
        dueOffsetDays,
        priority,
      } = config as {
        title: string;
        description?: string;
        agentId?: string;
        contactId?: string;
        dueDate?: string;
        dueOffsetDays?: number | string;
        priority?: "low" | "medium" | "high" | "urgent";
      };
      if (title) {
        // Default agentId/contactId to the resource being acted on so a rule
        // doesn't have to repeat them in config when the trigger already
        // points at the right record.
        const resolvedAgentId =
          taskAgentId ??
          (typeof context.agentId === "string" ? context.agentId : null) ??
          (resourceType === "agent" ? resourceId : null);
        const resolvedContactId =
          taskContactId ??
          (typeof context.contactId === "string" ? context.contactId : null) ??
          (resourceType === "contact" ? resourceId : null);

        let dueDate: Date | null = null;
        if (taskDueDate) {
          dueDate = new Date(taskDueDate);
        } else if (dueOffsetDays != null) {
          const days = Number(dueOffsetDays);
          if (Number.isFinite(days)) {
            dueDate = new Date(Date.now() + days * 86_400_000);
          }
        }

        await db.insert(taskInstancesTable).values({
          id: randomUUID(),
          orgId,
          templateId: null,
          agentId: resolvedAgentId,
          contactId: resolvedContactId,
          title,
          description:
            description ??
            `Auto-created by automation rule (${resourceType}: ${resourceId})`,
          status: "open",
          priority: priority ?? "medium",
          dueDate,
        });
      }
      break;
    }

    case "send_notification": {
      const { userId, message } = config as {
        userId?: string;
        message: string;
      };
      if (!message) break;

      // If a specific userId is supplied, notify only that user.
      // Otherwise, broadcast to all agency_admin users in the org.
      const targetUserIds: string[] = [];
      if (userId) {
        targetUserIds.push(userId);
      } else {
        const admins = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.orgId, orgId),
              inArray(usersTable.role, ["agency_admin", "super_admin"]),
              eq(usersTable.isActive, true),
            ),
          );
        for (const a of admins) targetUserIds.push(a.id);
      }

      for (const uid of targetUserIds) {
        await db.insert(notificationsTable).values({
          id: randomUUID(),
          orgId,
          userId: uid,
          type: "automation",
          title: "Automation Rule Fired",
          body: message,
          priority: "normal",
          resourceType,
          resourceId,
        });
      }
      break;
    }

    case "send_email": {
      const { to, subject, html } = config as {
        to?: string;
        subject: string;
        html: string;
      };
      if (!subject || !html) {
        logger.warn({ action: "send_email", resourceType, resourceId }, "send_email skipped — missing subject/html");
        break;
      }
      // An explicit `to` goes out as an internal notification only when it is
      // a staff address; a consumer's address is gated as that contact.
      // Without one, the email goes to the resource itself: an agent
      // (internal) or a consumer contact, gated at send time.
      if (to) {
        const recipient = await classifyExplicitRecipient(orgId, "email", to);
        if (recipient.kind === "internal") {
          await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, { to, subject, html });
        } else if (recipient.kind === "consumer") {
          await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
            to: "",
            subject,
            html,
            consumer: { orgId, contactId: recipient.contactId, automated: true },
          });
        } else {
          logger.warn(
            { action: "send_email", resourceType, resourceId },
            "send_email skipped — explicit recipient is neither staff nor a contact in this org",
          );
        }
        break;
      }
      const consumerContactId = consumerContactFor(resourceType, resourceId, context);
      if (consumerContactId) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
          to: typeof context.email === "string" ? context.email : "",
          subject,
          html,
          consumer: { orgId, contactId: consumerContactId, automated: true },
        });
        break;
      }
      if (resourceType === "agent" && resourceId) {
        const [a] = await db
          .select({ email: agentsTable.email })
          .from(agentsTable)
          .where(and(eq(agentsTable.id, resourceId), eq(agentsTable.orgId, orgId)));
        if (a?.email) {
          await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, { to: a.email, subject, html });
          break;
        }
      }
      logger.warn(
        { action: "send_email", resourceType, resourceId },
        "send_email skipped — no agent or contact recipient (consumer email requires a contact so opt-outs can be enforced)",
      );
      break;
    }

    case "send_sms": {
      const { to, body } = config as { to?: string; body: string };
      if (!body) {
        logger.warn({ action: "send_sms", resourceType, resourceId }, "send_sms skipped — missing body");
        break;
      }
      if (to) {
        const recipient = await classifyExplicitRecipient(orgId, "sms", to);
        if (recipient.kind === "internal") {
          await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, { to, body });
        } else if (recipient.kind === "consumer") {
          await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, {
            to: "",
            body,
            consumer: { orgId, contactId: recipient.contactId, automated: true },
          });
        } else {
          logger.warn(
            { action: "send_sms", resourceType, resourceId },
            "send_sms skipped — explicit recipient is neither staff nor a contact in this org",
          );
        }
        break;
      }
      const consumerContactId = consumerContactFor(resourceType, resourceId, context);
      if (consumerContactId) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, {
          to: typeof context.phone === "string" ? context.phone : "",
          body,
          consumer: { orgId, contactId: consumerContactId, automated: true },
        });
        break;
      }
      logger.warn(
        { action: "send_sms", resourceType, resourceId },
        "send_sms skipped — no contact recipient (consumer SMS requires a contact so opt-out, consent and texting hours can be enforced)",
      );
      break;
    }

    case "change_contact_status": {
      const { status } = config as { status: Contact["status"] };
      if (!status) break;
      // Resolve the target contactId: prefer the resource itself when it's a
      // contact; otherwise fall back to a contactId in the trigger context
      // (e.g. lead_created carries the related contactId).
      let targetContactId: string | null = null;
      if (resourceType === "contact" && resourceId) {
        targetContactId = resourceId;
      } else if (typeof context.contactId === "string") {
        targetContactId = context.contactId;
      }
      if (targetContactId) {
        await db
          .update(contactsTable)
          .set({ status })
          .where(
            and(
              eq(contactsTable.id, targetContactId),
              eq(contactsTable.orgId, orgId),
            ),
          );
      } else {
        logger.warn(
          { action: "change_contact_status", resourceType },
          "change_contact_status skipped — no contactId resolved",
        );
      }
      break;
    }

    case "enroll_sequence": {
      const { sequenceId, channel } = config as {
        sequenceId: string;
        channel?: "email" | "sms";
      };
      if (!sequenceId) break;
      // Same fallback as change_contact_status — accept a contactId from the
      // trigger context so lead_* triggers can enroll the linked contact.
      let targetContactId: string | null = null;
      if (resourceType === "contact" && resourceId) {
        targetContactId = resourceId;
      } else if (typeof context.contactId === "string") {
        targetContactId = context.contactId;
      }
      if (!targetContactId) {
        logger.warn(
          { action: "enroll_sequence", resourceType },
          "enroll_sequence skipped — no contactId resolved",
        );
        break;
      }

      // Create (or verify) an active enrollment record before scheduling the
      // first step — sendSequenceStepWorker requires an active enrollment row.
      const existing = await db
        .select({ id: sequenceEnrollmentsTable.id })
        .from(sequenceEnrollmentsTable)
        .where(
          and(
            eq(sequenceEnrollmentsTable.sequenceId, sequenceId),
            eq(sequenceEnrollmentsTable.contactId, targetContactId),
            eq(sequenceEnrollmentsTable.status, "active"),
          ),
        )
        .limit(1);

      // Resolve the first step's stable id so the enrollment carries
      // it from the moment it's created (and the enqueued job carries
      // it too). If the sequence has no steps at all, leave the
      // pointer null and let the worker complete the enrollment
      // gracefully on its first run.
      const [firstStep] = await db
        .select({ id: sequenceStepsTable.id })
        .from(sequenceStepsTable)
        .where(eq(sequenceStepsTable.sequenceId, sequenceId))
        .orderBy(sequenceStepsTable.orderIndex)
        .limit(1);

      if (!existing.length) {
        await db.insert(sequenceEnrollmentsTable).values({
          id: randomUUID(),
          sequenceId,
          contactId: targetContactId,
          status: "active",
          nextStepIndex: 0,
          nextStepId: firstStep?.id ?? null,
        });
      }

      await enqueue(JOB_NAMES.SEND_SEQUENCE_STEP, {
        sequenceId,
        contactId: targetContactId,
        stepId: firstStep?.id,
        stepIndex: 0,
        channel: channel ?? "sms",
      });
      break;
    }

    case "change_deal_stage": {
      const { stageId } = config as { stageId: string };
      if (resourceType === "deal" && resourceId && stageId) {
        await db
          .update(dealsTable)
          .set({ stageId })
          .where(
            and(eq(dealsTable.id, resourceId), eq(dealsTable.orgId, orgId)),
          );
      }
      break;
    }

    case "create_appointment": {
      await createAppointmentAction(config, { orgId, resourceType, resourceId, context });
      break;
    }

    default: {
      const unhandled = (action as { type: string }).type;
      logger.warn({ actionType: unhandled }, "Unknown automation action type — skipped");
      break;
    }
  }
}

// ---- create_appointment (stage2/calendar-branding) ----

/**
 * UTC instant for wall-clock `hh:mm` on the calendar date `ymd` in `timeZone`.
 * Two passes of offset correction make it DST-correct without a tz library.
 */
export function zonedWallTimeToUtc(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
    guess += target - asUtc;
  }
  return new Date(guess);
}

/**
 * Books an appointment from an automation rule.
 *
 * Config (all optional except where noted):
 *   title            default "Follow-up appointment"
 *   type             enrollment | review | renewal | consultation | other (default consultation)
 *   status           confirmed | pending (default pending — a human confirms)
 *   startsAt         explicit ISO date-time; otherwise:
 *   startOffsetDays  days from now (default 1)
 *   startTime        "HH:MM" wall-clock in the contact's timezone (default "10:00";
 *                    UTC when the contact's state is unknown)
 *   durationMinutes  5–720 (default 30)
 *   locationType     office | phone | video | home (default phone)
 *   agentId / contactId  default to the trigger's agent / contact, like create_task
 *   notes            stored encrypted, like notes typed in the UI
 */
async function createAppointmentAction(
  config: Record<string, unknown>,
  {
    orgId,
    resourceType,
    resourceId,
    context,
  }: { orgId: string; resourceType: string; resourceId: string; context: Record<string, unknown> },
): Promise<void> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

  const contactId =
    str(config.contactId) ??
    str(context.contactId) ??
    (resourceType === "contact" ? resourceId : undefined) ??
    null;
  const agentId =
    str(config.agentId) ??
    str(context.agentId) ??
    str(context.assignedAgentId) ??
    (resourceType === "agent" ? resourceId : undefined) ??
    null;

  let startsAt: Date | null = null;
  const explicit = str(config.startsAt);
  if (explicit && !Number.isNaN(Date.parse(explicit))) {
    startsAt = new Date(explicit);
  } else {
    const offsetDays = Number(config.startOffsetDays ?? 1);
    const days = Number.isFinite(offsetDays) ? Math.max(0, Math.min(365, offsetDays)) : 1;
    const time = str(config.startTime) && /^\d{1,2}:\d{2}$/.test(str(config.startTime)!)
      ? str(config.startTime)!
      : "10:00";
    let tz = "UTC";
    if (contactId) {
      const [c] = await db
        .select({ stateCode: contactsTable.stateCode })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)));
      tz = resolveTimezone(c?.stateCode ?? undefined, undefined) ?? "UTC";
    }
    const day = new Date(Date.now() + days * 86_400_000);
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(day);
    startsAt = zonedWallTimeToUtc(ymd, time, tz);
  }

  const duration = Number(config.durationMinutes ?? 30);
  const minutes = Number.isFinite(duration) ? Math.max(5, Math.min(720, duration)) : 30;
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  const title = str(config.title) ?? "Follow-up appointment";

  // A re-delivered trigger must not double-book the same slot.
  if (contactId) {
    const [dupe] = await db
      .select({ id: appointmentsTable.id })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.orgId, orgId),
          eq(appointmentsTable.contactId, contactId),
          eq(appointmentsTable.startsAt, startsAt),
          eq(appointmentsTable.title, title),
        ),
      )
      .limit(1);
    if (dupe) {
      logger.info({ appointmentId: dupe.id }, "create_appointment skipped — identical appointment exists");
      return;
    }
  }

  await insertAppointment({
    orgId,
    title,
    type: pick(config.type, APPOINTMENT_TYPES, "consultation"),
    status: pick(config.status, ["confirmed", "pending"] as const, "pending"),
    startsAt,
    endsAt,
    contactId,
    agentId,
    notes: str(config.notes) ?? null,
    locationType: pick(config.locationType, APPOINTMENT_LOCATION_TYPES, "phone"),
  });
}

// ---- Main worker ----

export async function runAutomationRulesWorker(
  data: RunAutomationRulesPayload,
): Promise<void> {
  const { orgId, trigger, resourceType, resourceId, context = {} } = data;

  const rules = await db
    .select()
    .from(automationRulesTable)
    .where(
      and(
        eq(automationRulesTable.orgId, orgId),
        eq(automationRulesTable.triggerType, trigger),
        eq(automationRulesTable.isActive, true),
      ),
    );

  logger.info({ orgId, trigger, ruleCount: rules.length }, "Evaluating automation rules");

  // Load the actual entity record and merge its attributes into the context so
  // condition fields (status, source, stateCode, carrierId, assignedAgentId,
  // contactStatus, etc.) resolve against real DB values.
  const enrichedContext: Record<string, unknown> = { ...context };

  if (resourceId) {
    try {
      if (resourceType === "contact") {
        const [row] = await db
          .select()
          .from(contactsTable)
          .where(and(eq(contactsTable.id, resourceId), eq(contactsTable.orgId, orgId)));
        if (row) {
          Object.assign(enrichedContext, {
            status: row.status,
            contactStatus: row.status,
            stateCode: row.stateCode,
            source: (row as Record<string, unknown>).source,
            assignedAgentId: row.assignedAgentId,
            currentPlanType: row.currentPlanType,
          });
        }
      } else if (resourceType === "lead") {
        const [row] = await db
          .select()
          .from(leadsTable)
          .where(and(eq(leadsTable.id, resourceId), eq(leadsTable.orgId, orgId)));
        if (row) {
          Object.assign(enrichedContext, {
            status: row.status,
            source: row.source,
            assignedAgentId: row.assignedAgentId,
            stateCode: (row as Record<string, unknown>).stateCode,
          });
        }
      } else if (resourceType === "license") {
        const [row] = await db
          .select()
          .from(stateLicensesTable)
          .where(eq(stateLicensesTable.id, resourceId));
        if (row) {
          Object.assign(enrichedContext, {
            stateCode: row.stateCode,
            agentId: row.agentId,
            status: row.status,
          });
        }
      } else if (resourceType === "certification") {
        const [row] = await db
          .select()
          .from(carrierCertificationsTable)
          .where(eq(carrierCertificationsTable.id, resourceId));
        if (row) {
          Object.assign(enrichedContext, {
            carrierId: row.carrierId,
            agentId: row.agentId,
            status: row.status,
          });
        }
      } else if (resourceType === "deal") {
        const [row] = await db
          .select()
          .from(dealsTable)
          .where(and(eq(dealsTable.id, resourceId), eq(dealsTable.orgId, orgId)));
        if (row) {
          Object.assign(enrichedContext, {
            status: (row as Record<string, unknown>).status,
            stageId: row.stageId,
            assignedAgentId: row.assignedAgentId,
          });
        }
      } else if (resourceType === "task") {
        const [row] = await db
          .select()
          .from(taskInstancesTable)
          .where(and(eq(taskInstancesTable.id, resourceId), eq(taskInstancesTable.orgId, orgId)));
        if (row) {
          Object.assign(enrichedContext, {
            status: row.status,
            assignedAgentId: row.agentId,
          });
        }
      } else if (resourceType === "agent") {
        const [row] = await db
          .select()
          .from(agentsTable)
          .where(and(eq(agentsTable.id, resourceId), eq(agentsTable.orgId, orgId)));
        if (row) {
          Object.assign(enrichedContext, {
            status: row.status,
            stateCode: (row as Record<string, unknown>).stateCode,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, resourceType, resourceId }, "Failed to enrich automation context — using raw context");
      captureWorkerError(err, { worker: "runAutomationRules", phase: "enrich", resourceType, resourceId });
    }
  }

  // Triggers that pass numeric context fields which must be checked against
  // per-rule triggerConfig thresholds before condition evaluation.
  const TIME_THRESHOLD_TRIGGERS: Record<string, string> = {
    license_expires: "daysUntilExpiry",
    certification_expiring: "daysUntilExpiry",
    ahip_deadline: "daysUntilDeadline",
    contact_no_activity: "daysSinceActivity",
    task_overdue: "daysOverdue",
  };

  for (const rule of rules) {
    // Check triggerConfig threshold (e.g. "fire only when daysUntilExpiry <= 30")
    const thresholdField = TIME_THRESHOLD_TRIGGERS[trigger];
    if (thresholdField) {
      const triggerConfig = (rule.triggerConfig as Record<string, unknown> | null) ?? {};
      const threshold = triggerConfig.daysThreshold;
      if (threshold !== undefined && threshold !== null) {
        const contextValue = Number(enrichedContext[thresholdField]);
        if (contextValue > Number(threshold)) {
          logger.debug(
            { ruleId: rule.id, contextValue, threshold },
            "Automation rule skipped — context value exceeds triggerConfig threshold",
          );
          continue;
        }
      }
    }

    const conditions = (rule.conditions as AutomationCondition[] | null) ?? [];
    const conditionsMet =
      conditions.length === 0 || evaluateConditions(conditions, enrichedContext);

    if (!conditionsMet) {
      logger.debug({ ruleId: rule.id }, "Automation rule conditions not met — skipping");
      continue;
    }

    const actions = (rule.actions as AutomationAction[] | null) ?? [];
    const actionsExecuted: string[] = [];
    const actionErrors: string[] = [];
    let result: "success" | "partial" | "failed" = "success";

    for (const action of actions) {
      try {
        await executeAction(action, {
          orgId,
          resourceType,
          resourceId,
          context: enrichedContext,
        });
        actionsExecuted.push(action.type);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actionErrors.push(`${action.type}: ${msg}`);
        logger.error(
          { err, ruleId: rule.id, actionType: action.type },
          "Automation action failed",
        );
        captureWorkerError(err, {
          worker: "runAutomationRules",
          phase: "executeAction",
          ruleId: rule.id,
          actionType: action.type,
          orgId,
          resourceType,
          resourceId,
        });
        result = actionsExecuted.length > 0 ? "partial" : "failed";
      }
    }

    await db.insert(automationRuleLogsTable).values({
      id: randomUUID(),
      ruleId: rule.id,
      triggerEvent: trigger,
      matchedRecordType: resourceType,
      matchedRecordId: resourceId,
      actionsExecuted,
      result,
      errorMessage: actionErrors.length > 0 ? actionErrors.join("; ") : null,
    });

    await db
      .update(automationRulesTable)
      .set({
        lastRunAt: new Date(),
        runCount: sql`${automationRulesTable.runCount} + 1`,
      })
      .where(eq(automationRulesTable.id, rule.id));

    logger.info(
      { ruleId: rule.id, actionsExecuted, result },
      "Automation rule executed",
    );
  }

  logger.info({ orgId, trigger }, "Automation rules evaluation complete");
}
