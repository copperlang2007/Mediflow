/**
 * State-machine for agent onboarding + carrier contracting workflows.
 *
 * Pure functions — no DB access, no IO. Routes ask `canTransitionX(from, to)`
 * before they UPDATE, and call `applyOnboardingTransition` / `applyContracting
 * Transition` to perform the write + emit an audit-log entry in one place.
 *
 * Two state graphs (one per table). Kept as `Set<string>` adjacency lists so
 * the rules read top-to-bottom in the same order as the workflow itself.
 *
 * Why a state-machine module instead of inline UPDATE WHERE clauses?
 *  - Carrier-paperwork bugs typically appear when something gets "stuck" —
 *    the state graph here is the single source of truth for what "stuck"
 *    means. Adding new statuses (e.g. a future "needs_correction") only
 *    requires touching this file.
 *  - Reproducible tests: every allowed/forbidden transition is exercised by
 *    a table-driven test (see `contracting-state-machine.test.ts`).
 */
import type { db as DbType, auditLogTable as AuditLogTableType } from "@workspace/db";
import { randomUUID } from "node:crypto";

// ---- Status union types -----------------------------------------------------

export const ONBOARDING_STATUSES = [
  "draft",
  "profile_in_progress",
  "documents_in_progress",
  "carriers_selected",
  "signing",
  "submitted",
  "complete",
  "cancelled",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const CONTRACTING_STATUSES = [
  "draft",
  "paperwork_generated",
  "signed",
  "submitted",
  "under_review",
  "appointed",
  "rejected",
  "cancelled",
  // Phase 1.5 POA pivot. `awaiting_admin_submission` is reached when the
  // agent signs the run-wide POA — INSUREitALL admins handle the off-system
  // carrier submissions and flip each row to `submitted` manually.
  // `invite_requested` is reached when the agent OPTS OUT of the POA — the
  // email-out worker sends a "please email the agent a contracting invite"
  // request to each carrier's appointment desk, and the admin flips each
  // row to `submitted` once the agent confirms they've completed the
  // carrier's web flow.
  "awaiting_admin_submission",
  "invite_requested",
] as const;
export type ContractingStatus = (typeof CONTRACTING_STATUSES)[number];

// Phase 1.5 POA pivot — string-enum tracked on `agent_onboarding_runs.poa_status`.
// Not enforced by a DB enum; the column is plain text and this module is
// the source of truth.
export const POA_STATUSES = [
  "not_applicable",
  "pending",
  "signed",
  "opted_out",
] as const;
export type PoaStatus = (typeof POA_STATUSES)[number];

export function isPoaStatus(s: string): s is PoaStatus {
  return (POA_STATUSES as readonly string[]).includes(s);
}

// ---- Transition tables ------------------------------------------------------

/**
 * Allowed onboarding-run transitions.
 *
 * Happy path: draft → profile → documents → carriers_selected → signing →
 * submitted → complete. `cancelled` is reachable from every non-terminal
 * state (admin can always abort). `complete` is terminal.
 */
const ONBOARDING_TRANSITIONS: Record<OnboardingStatus, ReadonlySet<OnboardingStatus>> = {
  draft: new Set(["profile_in_progress", "cancelled"]),
  profile_in_progress: new Set([
    "documents_in_progress",
    "carriers_selected",
    "cancelled",
  ]),
  documents_in_progress: new Set([
    "carriers_selected",
    "profile_in_progress",
    "cancelled",
  ]),
  carriers_selected: new Set([
    "signing",
    "documents_in_progress",
    "cancelled",
  ]),
  signing: new Set(["submitted", "carriers_selected", "cancelled"]),
  submitted: new Set(["complete", "cancelled"]),
  complete: new Set([]),
  cancelled: new Set([]),
};

/**
 * Allowed carrier-contracting-request transitions.
 *
 * Per-carrier sub-flow. Carrier responses (`under_review` → `appointed` /
 * `rejected`) come from the appointment desk, possibly asynchronously via
 * polling. `cancelled` is again reachable from anywhere non-terminal.
 */
const CONTRACTING_TRANSITIONS: Record<ContractingStatus, ReadonlySet<ContractingStatus>> = {
  // `draft` can now branch three ways:
  //   - `paperwork_generated`         legacy per-carrier signing flow
  //   - `awaiting_admin_submission`   Phase 1.5 POA path
  //   - `invite_requested`            Phase 1.5 opt-out path
  draft: new Set([
    "paperwork_generated",
    "awaiting_admin_submission",
    "invite_requested",
    "cancelled",
  ]),
  paperwork_generated: new Set(["signed", "draft", "cancelled"]),
  signed: new Set(["submitted", "cancelled"]),
  submitted: new Set(["under_review", "appointed", "rejected", "cancelled"]),
  under_review: new Set(["appointed", "rejected", "cancelled"]),
  appointed: new Set([]),
  rejected: new Set(["draft", "cancelled"]),
  cancelled: new Set([]),
  // POA path: admin submits off-system, marks the row `submitted` once
  // they've handed it off to the carrier. From there the existing
  // submitted → under_review/appointed/rejected branches drive the rest.
  awaiting_admin_submission: new Set(["submitted", "cancelled"]),
  // Opt-out path: admin records carrier-confirmed completion as
  // `submitted` once the agent verifies they've finished the carrier's
  // own web flow.
  invite_requested: new Set(["submitted", "cancelled"]),
};

// ---- Public predicates ------------------------------------------------------

export function isOnboardingStatus(s: string): s is OnboardingStatus {
  return (ONBOARDING_STATUSES as readonly string[]).includes(s);
}

export function isContractingStatus(s: string): s is ContractingStatus {
  return (CONTRACTING_STATUSES as readonly string[]).includes(s);
}

export function canTransitionOnboarding(
  from: OnboardingStatus,
  to: OnboardingStatus,
): boolean {
  if (from === to) return true; // idempotent no-op write
  return ONBOARDING_TRANSITIONS[from].has(to);
}

export function canTransitionContracting(
  from: ContractingStatus,
  to: ContractingStatus,
): boolean {
  if (from === to) return true;
  return CONTRACTING_TRANSITIONS[from].has(to);
}

/**
 * The set of transitions that count as "completed_steps" advances. Used by
 * the onboarding route to update the `completed_steps` jsonb in sync with
 * the status — separated from the transition table so the workflow can
 * introduce new statuses without rebuilding this map every time.
 */
export const ONBOARDING_STEP_ON_ENTER: Partial<Record<OnboardingStatus, string>> = {
  profile_in_progress: "profile_started",
  documents_in_progress: "documents_started",
  carriers_selected: "carriers",
  signing: "signature",
  submitted: "submission",
  complete: "complete",
};

// ---- Audit-log emission helper ---------------------------------------------

/**
 * Emit an audit-log row for a state transition.
 *
 * Kept generic over the audit table so this module stays IO-light — the
 * caller passes the live `db` + `auditLogTable` references. We don't write
 * the actual onboarding/contracting row here (that's the route's job, inside
 * its own org-scoped UPDATE) — we just record the (from → to) change.
 */
export interface TransitionAuditContext {
  orgId: string;
  userId: string | null;
  userRole: string | null;
  resourceType: "agent_onboarding" | "carrier_contracting";
  resourceId: string;
  from: string;
  to: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function emitTransitionAudit(
  database: typeof DbType,
  auditTable: typeof AuditLogTableType,
  ctx: TransitionAuditContext,
): Promise<void> {
  await database.insert(auditTable).values({
    id: randomUUID(),
    orgId: ctx.orgId,
    userId: ctx.userId,
    userRole: ctx.userRole,
    action: "update",
    resourceType: ctx.resourceType,
    resourceId: ctx.resourceId,
    changes: { transition: { from: ctx.from, to: ctx.to } },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
}
