/**
 * Contracting-orchestration task helpers.
 *
 * Centralizes every `task_instances` INSERT/close called inline from the
 * onboarding routes (`POST /onboarding/start`,
 * `POST /onboarding/:agentId/carriers/select`,
 * `POST /onboarding/:agentId/request-contracting`,
 * `POST /onboarding/:agentId/carriers/:carrierId/sign`, etc.).
 *
 * ## Why a separate module rather than ad-hoc inserts per route
 *
 * Three concerns:
 *
 *   1. **Idempotency.** Every contracting task carries a deterministic
 *      `contracting_task_key` (e.g. `${runId}:complete-profile`,
 *      `${carrierRequestId}:submit`) so double-clicks / route retries /
 *      pg-boss redeliveries collapse to a no-op via `onConflictDoNothing`
 *      against the partial unique index
 *      `task_instances_contracting_task_key_unique` (migration 0019).
 *      Mirror of the auto-assign-trigger pattern from migration 0010 — see
 *      `taskAutoAssign.ts` for the same idiom on the per-template axis.
 *
 *   2. **Single source of truth for titles / dedup keys.** When Day 6
 *      adds the "Submit signed packet to {carrierName} appointment desk"
 *      worker, it needs to know which task to close. Hard-coding the
 *      title string in two places drifts immediately; this module owns
 *      the format.
 *
 *   3. **Test surface.** Each helper is a single insert + return —
 *      direct DB assertion in tests is cheap. The orchestration tests
 *      drive the routes (integration), but they assert on the task rows
 *      these helpers produce.
 *
 * Closing a task means "mark it `completed`" — not delete — so the agent's
 * history still shows the step they finished. Closing is also idempotent:
 * a row already in `completed` is left alone (matches the gated UPDATE in
 * `PATCH /tasks/:id` that the agent UI already relies on).
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import {
  db,
  taskInstancesTable,
  type Agent,
  type AgentOnboardingRun,
  type CarrierContractingRequest,
  type TaskInstance,
} from "@workspace/db";

// ---- Dedup-key builders ----------------------------------------------------
//
// Exported for tests and for the eventual Day-6 worker that needs to look
// up "the submit task for this carrier request". Keeping them as helpers
// (rather than scattering `${runId}:foo` template strings across the
// codebase) means renaming a key is a single-file change.

export function completeProfileTaskKey(runId: string): string {
  return `${runId}:complete-profile`;
}

export function adminReviewTaskKey(runId: string): string {
  return `${runId}:admin-review`;
}

export function carrierSignTaskKey(
  runId: string,
  carrierRequestId: string,
): string {
  return `${runId}:sign:${carrierRequestId}`;
}

export function carrierSubmitTaskKey(carrierRequestId: string): string {
  return `${carrierRequestId}:submit`;
}

// ---- Phase 1.5 POA dedup keys ----------------------------------------------

/** Agent-facing "Decide whether to grant the run-wide POA" task. */
export function poaDecisionTaskKey(runId: string): string {
  return `${runId}:poa-decision`;
}

/** Admin task created after the agent signs the POA. */
export function adminPoaSubmitTaskKey(runId: string): string {
  return `${runId}:admin-poa-submit`;
}

/** Admin task created after the agent opts OUT of the POA. */
export function adminOptOutTrackTaskKey(runId: string): string {
  return `${runId}:admin-optout-track`;
}

// ---- Helpers ---------------------------------------------------------------

// Exported so other modules (esign callback, opt-out task helpers) can use
// the same display-name logic without re-importing the Agent type.
export function agentDisplayName(
  agent: Pick<Agent, "firstName" | "lastName">,
): string {
  return `${agent.firstName} ${agent.lastName}`.trim() || "agent";
}

/**
 * Insert a task row + dedupe on `(org_id, contracting_task_key)`.
 *
 * Returns the newly-created row, or — if a row with the same key already
 * exists — the existing row. The `onConflictDoNothing` path returns an
 * empty array from `.returning()`, so we re-`SELECT` to give the caller a
 * stable shape regardless of whether the insert won the race.
 */
async function insertContractingTask(
  values: Omit<typeof taskInstancesTable.$inferInsert, "id"> & {
    contractingTaskKey: string;
  },
): Promise<TaskInstance> {
  const id = randomUUID();
  const [row] = await db
    .insert(taskInstancesTable)
    .values({ id, ...values })
    .onConflictDoNothing({
      target: [
        taskInstancesTable.orgId,
        taskInstancesTable.contractingTaskKey,
      ],
      // Partial-unique index predicate must match exactly so PG can infer
      // the index for the ON CONFLICT clause — same idiom as the
      // auto_assign_trigger dedup in workers/taskAutoAssign.ts.
      where: isNotNull(taskInstancesTable.contractingTaskKey),
    })
    .returning();
  if (row) return row;

  // A concurrent caller won the race. Read the existing row back so the
  // caller still gets a TaskInstance to return / log against.
  const [existing] = await db
    .select()
    .from(taskInstancesTable)
    .where(
      and(
        eq(taskInstancesTable.orgId, values.orgId),
        eq(
          taskInstancesTable.contractingTaskKey,
          values.contractingTaskKey,
        ),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(
      `contractingTasks: failed to read back task after conflict (key=${values.contractingTaskKey})`,
    );
  }
  return existing;
}

// ---- Public helpers --------------------------------------------------------

/**
 * Agent-facing "fill out your contracting profile" task created when the
 * admin fires `POST /onboarding/start`. Assigned to the agent's linked
 * user (`agents.user_id`) when present; if the agent has no linked user
 * the task still exists, with `assignedToUserId = null`, so the admin
 * UI surfaces it as "unclaimed" and can re-assign manually.
 */
export async function createCompleteProfileTask(
  run: AgentOnboardingRun,
  agent: Pick<Agent, "id" | "userId" | "firstName" | "lastName">,
): Promise<TaskInstance> {
  return insertContractingTask({
    orgId: run.orgId,
    agentId: agent.id,
    title: "Complete contracting profile",
    description:
      "Fill out your SSN, address, E&O policy, and other paperwork data so the admin can request appointments with your selected carriers.",
    status: "open",
    priority: "high",
    assignedToUserId: agent.userId ?? null,
    createdBy: run.startedByUserId ?? null,
    contractingTaskKey: completeProfileTaskKey(run.id),
  });
}

/**
 * Admin-facing "review the agent's selections and request contracting" task
 * created when the run hits `carriers_selected`. Assigned to the admin who
 * started the run (tracked on `agent_onboarding_runs.started_by_user_id`).
 */
export async function createAdminReviewTask(
  run: AgentOnboardingRun,
  agent: Pick<Agent, "firstName" | "lastName">,
  adminUserId: string | null,
): Promise<TaskInstance> {
  return insertContractingTask({
    orgId: run.orgId,
    agentId: run.agentId,
    title: `Review and request contracting for ${agentDisplayName(agent)}`,
    description:
      "The agent has completed their profile and selected carriers. Review their selections and click 'Request contracting' to generate carrier paperwork.",
    status: "open",
    priority: "high",
    assignedToUserId: adminUserId,
    createdBy: run.startedByUserId ?? null,
    contractingTaskKey: adminReviewTaskKey(run.id),
  });
}

/**
 * Agent-facing "sign your contracting paperwork for {carrierName}" task
 * created one-per-carrier when the admin fires `request-contracting`.
 * Day 5 swaps the body for "you have a Dropbox Sign envelope waiting"; the
 * task row itself stays the same.
 */
export async function createCarrierSignTask(
  run: AgentOnboardingRun,
  carrierRequest: Pick<CarrierContractingRequest, "id" | "carrierId">,
  carrierName: string,
  agent: Pick<Agent, "id" | "userId">,
): Promise<TaskInstance> {
  return insertContractingTask({
    orgId: run.orgId,
    agentId: agent.id,
    title: `Sign contracting paperwork for ${carrierName}`,
    description:
      "Review and sign the contracting packet. Once signed, the admin will submit it to the carrier appointment desk.",
    status: "open",
    priority: "high",
    assignedToUserId: agent.userId ?? null,
    createdBy: run.startedByUserId ?? null,
    contractingTaskKey: carrierSignTaskKey(run.id, carrierRequest.id),
  });
}

/**
 * SYSTEM-owned "submit signed packet to {carrierName} appointment desk"
 * task. No assignee — Day 6's email-out worker drains rows from
 * task_instances where status='open' and contracting_task_key LIKE
 * '%:submit'. The admin dashboard surfaces this as a queued submission so
 * an admin can intervene if the worker stalls.
 */
export async function createCarrierSubmitTask(
  carrierRequest: Pick<
    CarrierContractingRequest,
    "id" | "orgId" | "agentId"
  >,
  carrierName: string,
): Promise<TaskInstance> {
  return insertContractingTask({
    orgId: carrierRequest.orgId,
    agentId: carrierRequest.agentId,
    title: `Submit signed packet to ${carrierName} appointment desk`,
    description:
      "System task — the email-out worker (Day 6) will pick this up and dispatch the packet to the carrier's appointment desk.",
    status: "open",
    priority: "medium",
    assignedTo: null,
    assignedToUserId: null,
    createdBy: null,
    contractingTaskKey: carrierSubmitTaskKey(carrierRequest.id),
  });
}

/**
 * Close (mark `completed`) a contracting task by its dedup key.
 *
 * Org-scoped + status-gated:
 *   - The org_id filter is defense-in-depth; the key is already org-
 *     unique via the partial unique index but every UPDATE keeps the
 *     explicit `eq(orgId)` predicate (PR #85 pattern).
 *   - The `status != 'completed'` predicate makes the close idempotent:
 *     a duplicate close request returns the existing completedAt rather
 *     than rewriting it.
 *
 * Returns the closed row if this call performed the transition,
 * `null` if no matching open task exists.
 */
export async function closeContractingTask(
  orgId: string,
  taskKey: string,
): Promise<TaskInstance | null> {
  const [row] = await db
    .update(taskInstancesTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(
      and(
        eq(taskInstancesTable.orgId, orgId),
        eq(taskInstancesTable.contractingTaskKey, taskKey),
        ne(taskInstancesTable.status, "completed"),
      ),
    )
    .returning();
  return row ?? null;
}
