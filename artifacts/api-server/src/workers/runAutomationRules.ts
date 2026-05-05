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
  notificationsTable,
  taskInstancesTable,
  usersTable,
  type Contact,
} from "@workspace/db";
import { type RunAutomationRulesPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";

// ---- Typed condition / action interfaces ----

interface AutomationCondition {
  field: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt" | "exists";
  value: unknown;
}

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

// ---- Condition evaluation ----

function evaluateCondition(
  cond: AutomationCondition,
  ctx: Record<string, unknown>,
): boolean {
  const actual = ctx[cond.field];
  switch (cond.operator) {
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "contains":
      return typeof actual === "string" && actual.includes(String(cond.value));
    case "gt":
      return Number(actual) > Number(cond.value);
    case "lt":
      return Number(actual) < Number(cond.value);
    case "exists":
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

function evaluateConditions(
  conditions: AutomationCondition[],
  ctx: Record<string, unknown>,
): boolean {
  if (conditions.length === 0) return true;
  // Process conditions respecting AND/OR logic.
  // Default logic is "and" for the first condition; each subsequent condition
  // uses its own `logic` to combine with the running result.
  let result = evaluateCondition(conditions[0]!, ctx);
  for (let i = 1; i < conditions.length; i++) {
    const cond = conditions[i]!;
    const logic = (cond as AutomationCondition & { logic?: string }).logic ?? "and";
    if (logic === "or") {
      result = result || evaluateCondition(cond, ctx);
    } else {
      result = result && evaluateCondition(cond, ctx);
    }
  }
  return result;
}

// ---- Action execution ----

async function executeAction(
  action: AutomationAction,
  {
    orgId,
    resourceType,
    resourceId,
  }: { orgId: string; resourceType: string; resourceId: string },
): Promise<void> {
  switch (action.type) {
    case "create_task": {
      const { title, agentId: taskAgentId, dueDate: taskDueDate } = action.config as {
        title: string;
        agentId?: string;
        dueDate?: string;
      };
      if (title) {
        await db.insert(taskInstancesTable).values({
          id: randomUUID(),
          orgId,
          templateId: null,
          agentId: (taskAgentId as string) ?? null,
          title,
          description: `Auto-created by automation rule (${resourceType}: ${resourceId})`,
          status: "open",
          priority: "medium",
          dueDate: taskDueDate ? new Date(taskDueDate) : null,
        });
      }
      break;
    }

    case "send_notification": {
      const { userId, message } = action.config as {
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
      const { to, subject, html } = action.config as {
        to: string;
        subject: string;
        html: string;
      };
      if (to && subject && html) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, { to, subject, html });
      }
      break;
    }

    case "send_sms": {
      const { to, body } = action.config as { to: string; body: string };
      if (to && body) {
        await enqueue(JOB_NAMES.SEND_SCHEDULED_SMS, { to, body });
      }
      break;
    }

    case "change_contact_status": {
      const { status } = action.config as { status: Contact["status"] };
      if (resourceType === "contact" && resourceId && status) {
        await db
          .update(contactsTable)
          .set({ status })
          .where(
            and(eq(contactsTable.id, resourceId), eq(contactsTable.orgId, orgId)),
          );
      }
      break;
    }

    case "enroll_sequence": {
      const { sequenceId } = action.config as { sequenceId: string };
      if (resourceType === "contact" && resourceId && sequenceId) {
        await enqueue(JOB_NAMES.SEND_SEQUENCE_STEP, {
          sequenceId,
          contactId: resourceId,
          stepIndex: 0,
          channel: "sms",
        });
      }
      break;
    }

    case "change_deal_stage": {
      const { stageId } = action.config as { stageId: string };
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

  for (const rule of rules) {
    const conditions = (rule.conditions as AutomationCondition[] | null) ?? [];
    const conditionsMet =
      conditions.length === 0 || evaluateConditions(conditions, context);

    if (!conditionsMet) {
      logger.debug({ ruleId: rule.id }, "Automation rule conditions not met — skipping");
      continue;
    }

    const actions = (rule.actions as AutomationAction[] | null) ?? [];
    const actionsExecuted: string[] = [];
    let result: "success" | "partial" | "failed" = "success";

    for (const action of actions) {
      try {
        await executeAction(action, { orgId, resourceType, resourceId });
        actionsExecuted.push(action.type);
      } catch (err) {
        logger.error(
          { err, ruleId: rule.id, actionType: action.type },
          "Automation action failed",
        );
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
