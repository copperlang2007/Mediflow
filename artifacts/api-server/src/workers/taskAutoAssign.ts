/**
 * Task Auto-Assignment Worker.
 *
 * Triggered when an agent is created or status changes.
 * Finds active task templates with a matching trigger event and creates instances.
 *
 * Retry semantics: pg-boss redelivers the job on worker crash, transient DB
 * error, or visibility-timeout expiry. The original implementation
 * re-inserted every matching template on each retry, so agents saw the
 * same auto-assigned task two, three, or N times.
 *
 * Idempotency invariant: at most one task is auto-created per
 * (agentId, templateId, trigger) tuple. The DB-level guarantee lives in
 * the partial unique index `task_instances_auto_assign_unique` (migration
 * 0010); this worker tags each row with the trigger and uses
 * `onConflictDoNothing` so retries collapse to a no-op. Distinct trigger
 * events for the same (agent, template) — e.g. agent_created followed
 * later by agent_status_changed — are NOT deduped against each other;
 * each gets its own row. Operators who want a second copy of a task on
 * the same trigger can clone the template.
 */

import { and, eq, isNotNull } from "drizzle-orm";
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
      autoAssignTrigger: trigger,
    };
  });

  // Dedupe on (agent_id, template_id, auto_assign_trigger) via the partial
  // unique index `task_instances_auto_assign_unique` (migration 0010).
  // The `where` predicate must match the index's partial predicate so
  // Postgres infers the correct constraint — all three columns are
  // always set above, but we still spell out the predicate so a future
  // refactor that loosens those guarantees doesn't silently fall back to
  // raising a primary-key conflict instead.
  const inserted = await db
    .insert(taskInstancesTable)
    .values(instances)
    .onConflictDoNothing({
      target: [
        taskInstancesTable.agentId,
        taskInstancesTable.templateId,
        taskInstancesTable.autoAssignTrigger,
      ],
      where: and(
        isNotNull(taskInstancesTable.templateId),
        isNotNull(taskInstancesTable.agentId),
        isNotNull(taskInstancesTable.autoAssignTrigger),
      ),
    })
    .returning({ id: taskInstancesTable.id });

  const skipped = instances.length - inserted.length;
  if (skipped > 0) {
    logger.info(
      {
        agentId,
        trigger,
        templates: templates.length,
        created: inserted.length,
        skipped,
      },
      "Task auto-assign: retry detected, some rows deduped",
    );
  } else {
    logger.info(
      { count: inserted.length, agentId, trigger },
      "Task instances created",
    );
  }
}
