/**
 * Compliance oversight tasks raised from inbound dialer events (Phase 4, §6).
 *
 * When the dialer reports a compliance-category disposition
 * (`call.disposition.recorded` with `category=COMPLIANCE`), a hard compliance
 * flag (`call.compliance.flagged`), or MediFlow's own in-platform transcript
 * parse surfaces a compliance concern (`call.transcript.ready` → Phase 5
 * agent-assist), MediFlow raises an oversight task in its own tasks system,
 * assigned to a compliance manager / agency admin, and audits it (§6, §9).
 * MediFlow is the system of record; the task lives here, never in the dialer.
 *
 * Idempotency: each task carries a deterministic `retentionReviewKey`
 * (reused as a generic dedup key — it is the only org-scoped partial-unique
 * key on `task_instances` not tied to onboarding/contracting). Keyed on the
 * triggering `eventId`, a duplicate webhook delivery collapses to a no-op via
 * `onConflictDoNothing`. PHI never enters the task (no MBI, no transcript).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db as defaultDb,
  taskInstancesTable,
  usersTable,
  auditLogTable,
  dialTicketsTable,
  type TaskInstance,
} from "@workspace/db";
import { logger } from "../logger";

type OversightDb = typeof defaultDb;

/** Deterministic dedup key for an oversight task raised from an event. */
export function oversightTaskKey(eventId: string): string {
  return `dialer-compliance:${eventId}`;
}

/** Roles that should own a compliance oversight task, most-specific first. */
const OVERSIGHT_ROLES = [
  "compliance_manager",
  "agency_admin",
  "super_admin",
] as const;

/**
 * Pick a compliance owner for the org: a compliance_manager if one exists,
 * else an agency_admin, else a super_admin. Returns null when the org has no
 * eligible active user (the task is still created, unassigned, so it surfaces
 * on the admin dashboard).
 */
async function pickComplianceOwner(
  db: OversightDb,
  orgId: string,
): Promise<string | null> {
  const candidates = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.orgId, orgId),
        eq(usersTable.isActive, true),
        inArray(usersTable.role, [...OVERSIGHT_ROLES]),
      ),
    );
  for (const role of OVERSIGHT_ROLES) {
    const match = candidates.find((c) => c.role === role);
    if (match) return match.id;
  }
  return null;
}

export interface RaiseOversightInput {
  orgId: string;
  eventId: string;
  dialTicketId?: string | null;
  dialerCallId?: string | null;
  /** "disposition" | "flag" | "transcript" — what triggered the task. */
  trigger: "disposition" | "flag" | "transcript";
  /** Disposition code / compliance rule, for the task body (no PHI). */
  reason?: string | null;
  detail?: string | null;
}

/**
 * Create (idempotently) a compliance oversight task and audit it. Returns the
 * task row, or null when a row for the same `eventId` already exists.
 */
export async function raiseComplianceOversightTask(
  input: RaiseOversightInput,
  db: OversightDb = defaultDb,
): Promise<TaskInstance | null> {
  const dedupKey = oversightTaskKey(input.eventId);

  // Resolve the contactRef for the task (so the compliance reviewer can open
  // the contact) from the dial ticket, if we have one. Never the MBI.
  let contactId: string | null = null;
  if (input.dialTicketId) {
    const [ticket] = await db
      .select({ contactRef: dialTicketsTable.contactRef })
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, input.dialTicketId))
      .limit(1);
    contactId = ticket?.contactRef ?? null;
  }

  const owner = await pickComplianceOwner(db, input.orgId);

  const title =
    input.trigger === "flag"
      ? `Compliance review: dialer flagged ${input.reason ?? "a call"}`
      : input.trigger === "transcript"
        ? `Compliance review: transcript flagged ${input.reason ?? "a call"}`
        : `Compliance review: ${input.reason ?? "compliance"} disposition`;
  const description = [
    input.trigger === "flag"
      ? "The dialer raised a hard compliance flag on an outbound call."
      : input.trigger === "transcript"
        ? "MediFlow's in-platform transcript parse surfaced a compliance concern on an outbound call."
        : "The dialer recorded a COMPLIANCE-category disposition on a call.",
    input.detail ? `Detail: ${input.detail}` : null,
    input.dialerCallId ? `Dialer call: ${input.dialerCallId}` : null,
    input.dialTicketId ? `Dial ticket: ${input.dialTicketId}` : null,
    "Review for TCPA / DNC / calling-hours and oversight follow-up.",
  ]
    .filter(Boolean)
    .join("\n");

  const id = randomUUID();
  const [row] = await db
    .insert(taskInstancesTable)
    .values({
      id,
      orgId: input.orgId,
      contactId,
      title,
      description,
      status: "open",
      priority: "urgent",
      assignedToUserId: owner,
      createdBy: null,
      retentionReviewKey: dedupKey,
    })
    .onConflictDoNothing({
      target: [
        taskInstancesTable.orgId,
        taskInstancesTable.retentionReviewKey,
      ],
      where: isNotNull(taskInstancesTable.retentionReviewKey),
    })
    .returning();

  if (!row) {
    // A previous delivery already raised this task — no-op (idempotent).
    return null;
  }

  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: input.orgId,
      userId: null,
      userRole: null,
      action: "create",
      resourceType: "compliance_oversight_task",
      resourceId: row.id,
      changes: {
        eventId: input.eventId,
        trigger: input.trigger,
        reason: input.reason ?? null,
        detail: input.detail ?? null,
        dialTicketId: input.dialTicketId ?? null,
        dialerCallId: input.dialerCallId ?? null,
        assignedToUserId: owner,
      },
    });
  } catch (err) {
    logger.error(
      { err, orgId: input.orgId, taskId: row.id },
      "Compliance oversight: failed to write audit log entry",
    );
  }

  return row;
}
