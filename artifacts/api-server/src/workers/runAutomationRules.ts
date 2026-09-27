/**
 * Run Automation Rules Worker.
 *
 * Evaluates active automation rules matching a trigger event for an org.
 * Executes matching actions and writes a log entry for each rule run.
 *
 * Action types must match ACTION_TYPES in routes/automations.ts:
 *   create_task | send_notification | send_email | send_sms |
 *   change_contact_status | enroll_sequence | change_deal_stage
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
  type Contact,
} from "@workspace/db";
import { type RunAutomationRulesPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";
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
    | "change_deal_stage";
  config: Record<string, unknown>;
}

// ---- Action execution ----

/** True when the contact has opted out of the given channel. */
async function contactOptedOut(orgId: string, contactId: string, channel: "email" | "sms"): Promise<boolean> {
  const [c] = await db
    .select({ optOutEmail: contactsTable.optOutEmail, optOutSms: contactsTable.optOutSms })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)));
  if (!c) return false;
  return channel === "email" ? c.optOutEmail : c.optOutSms;
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
      // Resolve `to` from the action config first; fall back to the resource's
      // own email so a rule like "send email" on a contact_created trigger
      // doesn't need to know the contact's address.
      let resolvedTo = to;
      if (!resolvedTo) {
        if (typeof context.email === "string") {
          resolvedTo = context.email;
        } else if (resourceType === "contact" && resourceId) {
          const [c] = await db
            .select({ email: contactsTable.email })
            .from(contactsTable)
            .where(and(eq(contactsTable.id, resourceId), eq(contactsTable.orgId, orgId)));
          if (c?.email) resolvedTo = c.email;
        } else if (resourceType === "agent" && resourceId) {
          const [a] = await db
            .select({ email: agentsTable.email })
            .from(agentsTable)
            .where(and(eq(agentsTable.id, resourceId), eq(agentsTable.orgId, orgId)));
          if (a?.email) resolvedTo = a.email;
        }
      }
      if (resolvedTo && resourceType === "contact" && resourceId
          && (await contactOptedOut(orgId, resourceId, "email"))) {
        logger.info({ action: "send_email", resourceId }, "send_email skipped — contact opted out of email");
        break;
      }
      if (resolvedTo && subject && html) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
          to: resolvedTo,
          subject,
          html,
        });
      } else {
        logger.warn(
          { action: "send_email", resourceType, resourceId, hasTo: !!resolvedTo },
          "send_email skipped — missing recipient/subject/html after resolution",
        );
      }
      break;
    }

    case "send_sms": {
      const { to, body } = config as { to?: string; body: string };
      let resolvedTo = to;
      if (!resolvedTo) {
        if (typeof context.phone === "string") {
          resolvedTo = context.phone;
        } else if (resourceType === "contact" && resourceId) {
          const [c] = await db
            .select({ phone: contactsTable.phone })
            .from(contactsTable)
            .where(and(eq(contactsTable.id, resourceId), eq(contactsTable.orgId, orgId)));
          if (c?.phone) resolvedTo = c.phone;
        }
      }
      if (resolvedTo && resourceType === "contact" && resourceId
          && (await contactOptedOut(orgId, resourceId, "sms"))) {
        logger.info({ action: "send_sms", resourceId }, "send_sms skipped — contact opted out of SMS");
        break;
      }
      if (resolvedTo && body) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, { to: resolvedTo, body });
      } else {
        logger.warn(
          { action: "send_sms", resourceType, resourceId, hasTo: !!resolvedTo },
          "send_sms skipped — missing recipient/body after resolution",
        );
      }
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

    default: {
      const unhandled = (action as { type: string }).type;
      logger.warn({ actionType: unhandled }, "Unknown automation action type — skipped");
      break;
    }
  }
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
