/**
 * Task Auto-Assignment Worker.
 *
 * Triggered when an agent is created or status changes.
 * Finds active task templates with a matching trigger event and creates instances.
 */

import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  taskTemplatesTable,
  taskInstancesTable,
} from "@workspace/db";
import { type TaskAutoAssignPayload } from "../lib/jobs";
import { logger } from "../lib/logger";

export async function taskAutoAssignWorker(
  data: TaskAutoAssignPayload,
): Promise<void> {
  const { agentId, orgId, trigger } = data;

  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);

  if (!agent) {
    logger.warn({ agentId }, "Task auto-assign: agent not found");
    return;
  }

  const templates = await db
    .select()
    .from(taskTemplatesTable)
    .where(
      and(
        eq(taskTemplatesTable.orgId, orgId),
        eq(taskTemplatesTable.triggerEvent, trigger),
        eq(taskTemplatesTable.isActive, true),
      ),
    );

  logger.info(
    { agentId, trigger, templates: templates.length },
    "Task auto-assign: creating task instances",
  );

  if (templates.length === 0) return;

  const instances = templates.map((tmpl) => {
    const dueDate = tmpl.dueDaysFromTrigger
      ? new Date(Date.now() + tmpl.dueDaysFromTrigger * 24 * 60 * 60 * 1000)
      : null;

    return {
      id: randomUUID(),
      orgId,
      templateId: tmpl.id,
      agentId,
      title: tmpl.title || tmpl.name,
      description: tmpl.description ?? null,
      status: "open" as const,
      priority: tmpl.priority,
      dueDate,
    };
  });

  await db.insert(taskInstancesTable).values(instances);
  logger.info({ count: instances.length, agentId }, "Task instances created");
}
