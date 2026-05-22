/**
 * Carrier-contracting onboarding-flow handoff for the e-signature provider.
 *
 * When an envelope completes, the contracting workflow needs to:
 *
 *   1. Transition the matching `carrier_contracting_requests` row to
 *      `signed` (with `signatureCompletedAt = now()`).
 *   2. Close the agent's "Sign contracting paperwork for {carrier}" task.
 *   3. Create the SYSTEM "Submit signed packet" task that Day 6's
 *      email-out worker drains.
 *   4. Roll the onboarding run forward if every request is past `signed`
 *      (the existing maybeAdvanceRunForRequests handles this lazily).
 *
 * This is what the Day-3 synchronous `POST /onboarding/.../sign` route used
 * to do inline. Extracting it into a callable function means both the
 * native e-sign completion path AND a hypothetical legacy retry can fire
 * the same transition without duplicating logic — and the unit tests for
 * the helper exercise the orchestration directly.
 *
 * Idempotent: if the request is already past `signed`, this is a no-op
 * (the state-machine same-status check + task close gating handle that).
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  agentOnboardingRunsTable,
  carrierContractingRequestsTable,
  carriersTable,
  notificationsTable,
  type CarrierContractingRequest,
  type AgentOnboardingRun,
} from "@workspace/db";
import {
  carrierSignTaskKey,
  closeContractingTask,
  createCarrierSubmitTask,
  adminReviewTaskKey,
} from "../../workers/contractingTasks";
import {
  canTransitionContracting,
  canTransitionOnboarding,
  ONBOARDING_STEP_ON_ENTER,
  type ContractingStatus,
  type OnboardingStatus,
} from "../../workers/contractingStateMachine";
import { enqueue, JOB_NAMES } from "../jobs";
import { logger } from "../logger";
import { randomUUID } from "node:crypto";

/**
 * Statuses that count as "already signed" — short-circuit the transition
 * so a re-completion doesn't double-create the submit task. Mirrors the
 * same predicate from the legacy `POST /onboarding/.../sign` route.
 */
const POST_SIGNED_STATUSES = new Set<ContractingStatus>([
  "signed",
  "submitted",
  "under_review",
  "appointed",
  "rejected",
]);

export interface CompleteCarrierSigningResult {
  request: CarrierContractingRequest;
  /** True when this call performed the transition; false when it was a no-op. */
  transitioned: boolean;
  /** The submit-task that drives Day-6 email-out (always present). */
  submitTaskId: string | null;
}

/**
 * Apply the carrier-side state changes that the legacy synchronous Day-3
 * `sign` route did inline. Org-scoped, idempotent, safe to call multiple
 * times.
 */
export async function completeCarrierSigningTransition(
  orgId: string,
  carrierContractingRequestId: string,
): Promise<CompleteCarrierSigningResult | null> {
  const [request] = await db
    .select()
    .from(carrierContractingRequestsTable)
    .where(
      and(
        eq(carrierContractingRequestsTable.id, carrierContractingRequestId),
        eq(carrierContractingRequestsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!request) return null;

  // Idempotent fast path: re-completion of an already-signed envelope.
  // We still call the run aggregator so a re-completion triggered by an
  // admin (e.g. after a Day-6 worker flipped requests to `appointed`)
  // can roll the onboarding run forward to `complete`.
  if (POST_SIGNED_STATUSES.has(request.status as ContractingStatus)) {
    await maybeAdvanceRunForRequests(request.onboardingRunId, orgId);
    return { request, transitioned: false, submitTaskId: null };
  }

  if (!canTransitionContracting(request.status as ContractingStatus, "signed")) {
    // The contracting request is in a state that does not permit moving to
    // `signed` (e.g. still `draft`, or already `cancelled`). The envelope
    // is technically completed but the workflow guard wins — log a warning
    // via the audit_log indirectly (the route's auditMiddleware captures
    // the envelope-complete call) and skip.
    return { request, transitioned: false, submitTaskId: null };
  }

  const [updated] = await db
    .update(carrierContractingRequestsTable)
    .set({
      status: "signed",
      signatureCompletedAt: new Date(),
      lastStatusChangeAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(carrierContractingRequestsTable.id, carrierContractingRequestId),
        eq(carrierContractingRequestsTable.orgId, orgId),
      ),
    )
    .returning();
  if (!updated) return null;

  // Look up the run + the carrier name for the submit-task title.
  const [run] = await db
    .select()
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.id, updated.onboardingRunId),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    )
    .limit(1);
  const [carrier] = await db
    .select({ id: carriersTable.id, name: carriersTable.name })
    .from(carriersTable)
    .where(
      and(
        eq(carriersTable.id, updated.carrierId),
        eq(carriersTable.orgId, orgId),
      ),
    )
    .limit(1);
  const carrierName = carrier?.name ?? "the carrier";

  // Close the agent's sign task — idempotent on already-completed.
  if (run) {
    await closeContractingTask(
      orgId,
      carrierSignTaskKey(run.id, updated.id),
    );
  }

  // Create the SYSTEM submit task. The Day-6 email-out worker drains these.
  const submitTask = await createCarrierSubmitTask(updated, carrierName);

  // Direct-enqueue the Day-6 email-out worker. `singletonKey` collapses
  // duplicate enqueues (e.g. an idempotent re-completion of the same
  // envelope) to a single in-flight job; the worker itself ALSO re-checks
  // the request status on entry so a singleton-race miss still no-ops.
  //
  // `enqueue` is never-throw — a transient pg-boss outage is logged and the
  // task stays open for a later poll/retry rather than failing the e-sign
  // completion that already committed.
  const jobId = await enqueue(
    JOB_NAMES.SUBMIT_CONTRACTING_PACKET,
    { carrierContractingRequestId: updated.id, orgId },
    { singletonKey: `submit:${updated.id}` },
  );
  if (!jobId) {
    logger.warn(
      { requestId: updated.id, orgId },
      "carrierSignCallback: submit-packet enqueue returned null — submit task left open for retry",
    );
  }

  // Roll the onboarding run forward if every request is past `signed`.
  if (run) {
    await maybeAdvanceRunForRequests(run.id, orgId);
  }

  return {
    request: updated,
    transitioned: true,
    submitTaskId: submitTask.id,
  };
}

/**
 * Local copy of `maybeAdvanceRunForRequests` from `routes/onboarding.ts`,
 * kept here so the envelope-completion path doesn't need to import a route
 * module (circular-import risk). The behaviour is intentionally identical
 * — duplication is preferred over coupling the two modules.
 *
 * Exported so the Day-6 email-out worker (`workers/submitContractingPacket.ts`)
 * can fire the same aggregator after flipping a request to `submitted` —
 * when the LAST request in a run lands `submitted` (or `appointed`), the
 * onboarding run advances and the completion notification fires.
 */
export async function maybeAdvanceRunForRequests(
  runId: string,
  orgId: string,
): Promise<void> {
  const [run] = await db
    .select()
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.id, runId),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!run) return;

  const requests = await db
    .select()
    .from(carrierContractingRequestsTable)
    .where(
      and(
        eq(carrierContractingRequestsTable.onboardingRunId, runId),
        eq(carrierContractingRequestsTable.orgId, orgId),
        sql`${carrierContractingRequestsTable.status} != 'cancelled'`,
      ),
    );
  if (requests.length === 0) return;

  const allSubmitted = requests.every((r) =>
    ["submitted", "under_review", "appointed", "rejected"].includes(r.status),
  );
  const allAppointed = requests.every((r) => r.status === "appointed");

  if (allAppointed && run.status !== "complete") {
    await applyOnboardingTransition(run, orgId, "signing", "submitted");
    await applyOnboardingTransition(
      { ...run, status: "submitted" },
      orgId,
      "submitted",
      "complete",
    );
    await closeContractingTask(orgId, adminReviewTaskKey(run.id));
    if (run.startedByUserId) {
      await db.insert(notificationsTable).values({
        id: randomUUID(),
        orgId,
        userId: run.startedByUserId,
        type: "onboarding_complete",
        title: "Agent onboarding complete",
        body: "All carrier appointments have been recorded — the agent is fully onboarded.",
        priority: "normal",
        resourceType: "agent_onboarding",
        resourceId: run.id,
      });
    }
    return;
  }

  if (allSubmitted && run.status === "signing") {
    await applyOnboardingTransition(run, orgId, "signing", "submitted");
  }
}

async function applyOnboardingTransition(
  run: AgentOnboardingRun,
  orgId: string,
  fromOk: OnboardingStatus,
  to: OnboardingStatus,
): Promise<void> {
  if (run.status !== fromOk) return;
  if (!canTransitionOnboarding(fromOk, to)) return;
  const completedSteps =
    typeof run.completedSteps === "object" && run.completedSteps !== null
      ? { ...(run.completedSteps as Record<string, unknown>) }
      : {};
  const stepKey = ONBOARDING_STEP_ON_ENTER[to];
  if (stepKey) completedSteps[stepKey] = true;
  await db
    .update(agentOnboardingRunsTable)
    .set({
      status: to,
      completedSteps,
      completedAt: to === "complete" ? new Date() : run.completedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentOnboardingRunsTable.id, run.id),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    );
}
