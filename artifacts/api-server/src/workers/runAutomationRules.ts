/**
 * Run Automation Rules Worker.
 *
 * Evaluates active automation rules matching a trigger event for an org.
 * Executes matching actions (send email/SMS, update contact, add tag, etc.)
 * and writes a log entry for each rule run.
 *
 * Also used by the weekly automation sweep (run without a specific resourceId
 * to evaluate time-based "scheduled" trigger rules across all orgs).
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  automationRulesTable,
  automationRuleLogsTable,
  contactsTable,
  taskInstancesTable,
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
    | "send_email"
    | "send_sms"
    | "update_contact_status"
    | "add_contact_tag"
    | "enroll_sequence"
    | "create_task";
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
  return conditions.every((c) => evaluateCondition(c, ctx));
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

    case "update_contact_status": {
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

    case "add_contact_tag": {
      const { tag } = action.config as { tag: string };
      if (resourceType === "contact" && resourceId && tag) {
        const [contact] = await db
          .select({ tags: contactsTable.tags })
          .from(contactsTable)
          .where(eq(contactsTable.id, resourceId))
          .limit(1);
        if (contact) {
          const existing = contact.tags ?? [];
          if (!existing.includes(tag)) {
            await db
              .update(contactsTable)
              .set({ tags: [...existing, tag] })
              .where(eq(contactsTable.id, resourceId));
          }
        }
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

    case "create_task": {
      const { title, agentId: taskAgentId } = action.config as {
        title: string;
        agentId?: string;
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
          dueDate: null,
        });
      }
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
