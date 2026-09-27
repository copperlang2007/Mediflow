/**
 * Retention Enforcement Worker
 *
 * Runs daily at 02:00 UTC via pg-boss schedule.
 *
 * Every window is clamped to the CMS 10-year record-retention floor
 * (lib/compliance/retention.ts). Contacts are only eligible once they are not
 * a current member and any enrollment ended more than the window ago.
 *
 * For each organisation with an enabled data retention policy:
 *  1. Soft-delete active records whose createdAt has passed the retention window
 *     and create a "retention_review" task so an admin can confirm hard-deletion.
 *  2. For records that are already soft-deleted and have passed the retention window,
 *     create a separate hard-delete review task prompting permanent removal.
 *
 * Supported record types: contacts, deals
 */

import { and, count, eq, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  organizationsTable,
  dataRetentionPoliciesTable,
  contactsTable,
  dealsTable,
  agentsTable,
  messageThreadsTable,
  documentsTable,
  auditLogTable,
  taskInstancesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { effectiveRetentionDays } from "../lib/compliance/retention";

/**
 * Build the deterministic dedup key for a retention review task.
 *
 * Shape: `${entityType}:${entityId}:${phase}`. Persisted in
 * `task_instances.retention_review_key` and backed by a partial unique
 * index on `(org_id, retention_review_key) WHERE retention_review_key
 * IS NOT NULL` (migration 0011). The worker inserts with
 * `ON CONFLICT DO NOTHING` against that index, so two entities with
 * identical human-rendered titles (e.g. two agents named "John Smith")
 * each get their own review task and a sweep re-run never piles on
 * duplicates.
 */
function retentionReviewKey(
  entityType: "agent" | "contact" | "deal" | "communication" | "document" | "audit_log",
  entityId: string,
  phase:
    | "soft-delete-review"
    | "hard-delete-review"
    | "review",
): string {
  return `${entityType}:${entityId}:${phase}`;
}

// Full set of retention policy types configured in the admin UI
const SUPPORTED_RECORD_TYPES = ["contacts", "deals", "agents", "communications", "documents", "audit_log"] as const;
type SupportedRecordType = (typeof SUPPORTED_RECORD_TYPES)[number];

export async function retentionEnforcementWorker(): Promise<void> {
  logger.info("retention-enforcement: starting run");

  const orgs = await db.select({ id: organizationsTable.id }).from(organizationsTable);

  let totalSoftDeleted = 0;
  let totalHardDeleteTasksCreated = 0;

  for (const org of orgs) {
    // Serialize the whole per-org sweep behind a Postgres advisory lock.
    //
    // Without this, two concurrent runs (clock-skewed cron double-fire, a
    // manual re-trigger overlapping the scheduled run, or two pg-boss
    // workers both claiming the job) race in the soft-delete phase: both
    // SELECT `deleted_at IS NULL` for the same record before either
    // commits, then both proceed. The retention-review TASK is deduped by
    // `task_instances.retention_review_key` (PR #77), but the
    // `retention_soft_delete` audit-log row is NOT — it inserts with a
    // fresh `randomUUID()` and no `ON CONFLICT`, so a concurrent run writes
    // a DUPLICATE audit row for a single logical soft-delete. A duplicated
    // audit trail is a HIPAA integrity problem.
    //
    // `pg_advisory_xact_lock` is transaction-scoped: a second concurrent
    // run for the SAME org blocks here until the first transaction
    // commits, then sees the already-applied state (`deleted_at` set,
    // review task present) and no-ops. The lock key is hashed per-org, so
    // different orgs' sweeps still run concurrently. The lock is released
    // automatically on commit/rollback — no try/finally cleanup needed.
    //
    // The per-org sweep is a bounded batch (a handful of SELECT/UPDATE/
    // INSERT loops over expired rows, no external network calls), so
    // holding one transaction for its duration is acceptable; this mirrors
    // the commission-reconcile lock from PR #69.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('retention_enforcement:' || ${org.id}))`,
      );

      const result = await runOrgSweep(tx, org.id);
      totalSoftDeleted += result.softDeleted;
      totalHardDeleteTasksCreated += result.hardDeleteTasksCreated;
    });
  }

  logger.info(
    { totalSoftDeleted, totalHardDeleteTasksCreated },
    "retention-enforcement: run complete",
  );
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run the retention sweep for a single org inside the caller's
 * transaction (which holds the per-org advisory lock).
 */
async function runOrgSweep(
  db: Tx,
  orgId: string,
): Promise<{ softDeleted: number; hardDeleteTasksCreated: number }> {
  let totalSoftDeleted = 0;
  let totalHardDeleteTasksCreated = 0;
  const org = { id: orgId };

  {
    const policies = await db
      .select()
      .from(dataRetentionPoliciesTable)
      .where(
        and(
          eq(dataRetentionPoliciesTable.orgId, org.id),
          eq(dataRetentionPoliciesTable.isEnabled, true),
        ),
      );

    for (const policy of policies) {
      if (!SUPPORTED_RECORD_TYPES.includes(policy.recordType as SupportedRecordType)) continue;

      // Never below the CMS 10-year floor, even if a legacy policy row was
      // saved with a shorter window before the floor was enforced.
      const retentionDays = effectiveRetentionDays(policy.retentionDays);
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      if (policy.recordType === "contacts") {
        // Phase 1: soft-delete active contacts past retention window
        const expired = await db
          .select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName })
          .from(contactsTable)
          .where(
            and(
              eq(contactsTable.orgId, org.id),
              isNull(contactsTable.deletedAt),
              lt(contactsTable.createdAt, cutoff),
              // A member's record is retained for the full window after their
              // coverage relationship ends, not after the contact row was
              // created: skip current members and anyone with an enrollment
              // that is still active or ended inside the window.
              sql`${contactsTable.status} <> 'enrolled'`,
              sql`NOT EXISTS (
                SELECT 1 FROM enrollments e
                WHERE e.contact_id = ${contactsTable.id}
                  AND (e.disenrolled_date IS NULL OR e.disenrolled_date > ${cutoff})
              )`,
            ),
          );

        for (const contact of expired) {
          await db
            .update(contactsTable)
            .set({ deletedAt: new Date() })
            .where(eq(contactsTable.id, contact.id));

          await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: `Retention review: contact ${contact.firstName} ${contact.lastName}`,
              description: `Contact soft-deleted by automated retention policy (${retentionDays} days). Review and confirm hard delete or restore.`,
              status: "open",
              priority: "medium",
              dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: retentionReviewKey("contact", contact.id, "soft-delete-review"),
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_soft_delete",
            resourceType: "contact",
            resourceId: contact.id,
            changes: { retentionDays: retentionDays, cutoff: cutoff.toISOString() },
          });

          totalSoftDeleted++;
        }

        // Phase 2: create hard-delete review tasks for already-soft-deleted contacts past window
        // Idempotent: skip if an open review task for this contact already exists (title-keyed)
        const softDeleted = await db
          .select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName, deletedAt: contactsTable.deletedAt })
          .from(contactsTable)
          .where(
            and(
              eq(contactsTable.orgId, org.id),
              isNotNull(contactsTable.deletedAt),
              lt(contactsTable.deletedAt!, cutoff),
            ),
          );

        for (const contact of softDeleted) {
          const taskTitle = `Hard-delete approval required: contact ${contact.firstName} ${contact.lastName}`;
          const key = retentionReviewKey("contact", contact.id, "hard-delete-review");

          // Dedup by (orgId, retentionReviewKey) — NOT by title. Two contacts
          // with the same name no longer collide, and a worker re-run does
          // not pile on duplicates for the same contact in the same phase.
          const inserted = await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `Contact was soft-deleted and has now exceeded the ${retentionDays}-day retention window. Approve permanent deletion via Admin > Compliance > Data Retention.`,
              status: "open",
              priority: "high",
              dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: key,
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            })
            .returning({ id: taskInstancesTable.id });

          if (inserted.length === 0) continue;

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_hard_delete_review_created",
            resourceType: "contact",
            resourceId: contact.id,
            changes: { retentionDays: retentionDays, deletedAt: contact.deletedAt?.toISOString() },
          });

          totalHardDeleteTasksCreated++;
        }
      }

      if (policy.recordType === "deals") {
        // Phase 1: soft-delete active deals past retention window
        const expiredDeals = await db
          .select({ id: dealsTable.id, title: dealsTable.title })
          .from(dealsTable)
          .where(
            and(
              eq(dealsTable.orgId, org.id),
              isNull(dealsTable.deletedAt),
              lt(dealsTable.createdAt, cutoff),
            ),
          );

        for (const deal of expiredDeals) {
          await db
            .update(dealsTable)
            .set({ deletedAt: new Date() })
            .where(eq(dealsTable.id, deal.id));

          await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: `Retention review: deal "${deal.title}"`,
              description: `Deal soft-deleted by automated retention policy (${retentionDays} days). Review and confirm hard delete or restore.`,
              status: "open",
              priority: "medium",
              dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: retentionReviewKey("deal", deal.id, "soft-delete-review"),
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_soft_delete",
            resourceType: "deal",
            resourceId: deal.id,
            changes: { retentionDays: retentionDays, cutoff: cutoff.toISOString() },
          });

          totalSoftDeleted++;
        }

        // Phase 2: hard-delete review tasks for already-soft-deleted deals past window
        // Idempotent: skip if an open review task for this deal already exists (title-keyed)
        const softDeletedDeals = await db
          .select({ id: dealsTable.id, title: dealsTable.title, deletedAt: dealsTable.deletedAt })
          .from(dealsTable)
          .where(
            and(
              eq(dealsTable.orgId, org.id),
              isNotNull(dealsTable.deletedAt),
              lt(dealsTable.deletedAt!, cutoff),
            ),
          );

        for (const deal of softDeletedDeals) {
          const taskTitle = `Hard-delete approval required: deal "${deal.title}"`;
          const key = retentionReviewKey("deal", deal.id, "hard-delete-review");

          const inserted = await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `Deal was soft-deleted and has now exceeded the ${retentionDays}-day retention window. Approve permanent deletion via Admin > Compliance > Data Retention.`,
              status: "open",
              priority: "high",
              dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: key,
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            })
            .returning({ id: taskInstancesTable.id });

          if (inserted.length === 0) continue;

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_hard_delete_review_created",
            resourceType: "deal",
            resourceId: deal.id,
            changes: { retentionDays: retentionDays, deletedAt: deal.deletedAt?.toISOString() },
          });

          totalHardDeleteTasksCreated++;
        }
      }

      // ── agents ──────────────────────────────────────────────────────────
      // agentsTable has no deletedAt column. Retention enforcement creates
      // review tasks for agent records that have existed beyond the window.
      // Automatic deletion is not performed — human approval is required.
      if (policy.recordType === "agents") {
        const expiredAgents = await db
          .select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName })
          .from(agentsTable)
          .where(and(eq(agentsTable.orgId, org.id), lt(agentsTable.createdAt, cutoff)));

        for (const agent of expiredAgents) {
          const taskTitle = `Retention review required: agent "${agent.firstName} ${agent.lastName}"`;
          // Dedup by (orgId, entityType, entityId, phase) — NOT by title.
          // Two agents in the same org with identical names previously
          // collided on `taskTitle` and the second never got a review task,
          // which let the next sweep proceed to delete BOTH on the basis
          // of a review that only ever covered one. Keying by `agent.id`
          // closes that compliance gap.
          const key = retentionReviewKey("agent", agent.id, "soft-delete-review");

          const inserted = await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `Agent record has existed for more than ${retentionDays} days. Review per data retention policy and determine if the record should be purged, anonymised, or retained.`,
              status: "open",
              priority: "medium",
              dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: key,
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            })
            .returning({ id: taskInstancesTable.id });

          if (inserted.length === 0) continue;

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_review_created",
            resourceType: "agent",
            resourceId: agent.id,
            changes: { retentionDays: retentionDays, cutoff: cutoff.toISOString() },
          });

          totalHardDeleteTasksCreated++;
        }
      }

      // ── communications ───────────────────────────────────────────────────
      // messageThreadsTable has no deletedAt column. Create review tasks for
      // threads whose lastMessageAt (or createdAt) is before the cutoff.
      if (policy.recordType === "communications") {
        const expiredThreads = await db
          .select({ id: messageThreadsTable.id, contactId: messageThreadsTable.contactId, channel: messageThreadsTable.channel })
          .from(messageThreadsTable)
          .where(and(eq(messageThreadsTable.orgId, org.id), lt(messageThreadsTable.createdAt, cutoff)));

        for (const thread of expiredThreads) {
          const taskTitle = `Retention review: ${thread.channel} thread (contact ${thread.contactId})`;
          const key = retentionReviewKey("communication", thread.id, "review");

          const inserted = await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `Communication thread has exceeded the ${retentionDays}-day retention window. Review and purge if required by policy.`,
              status: "open",
              priority: "medium",
              dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: key,
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            })
            .returning({ id: taskInstancesTable.id });

          if (inserted.length === 0) continue;

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_review_created",
            resourceType: "communication",
            resourceId: thread.id,
            changes: { retentionDays: retentionDays, cutoff: cutoff.toISOString() },
          });

          totalHardDeleteTasksCreated++;
        }
      }

      // ── documents ────────────────────────────────────────────────────────
      // documentsTable has no deletedAt column. Create review tasks for
      // documents whose createdAt is before the cutoff.
      if (policy.recordType === "documents") {
        const expiredDocs = await db
          .select({ id: documentsTable.id, name: documentsTable.name, category: documentsTable.category })
          .from(documentsTable)
          .where(and(eq(documentsTable.orgId, org.id), lt(documentsTable.createdAt, cutoff)));

        for (const doc of expiredDocs) {
          const taskTitle = `Retention review: document "${doc.name}"`;
          const key = retentionReviewKey("document", doc.id, "review");

          const inserted = await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `Document "${doc.name}" (${doc.category}) has exceeded the ${retentionDays}-day retention window. Review and purge if required by policy.`,
              status: "open",
              priority: "medium",
              dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: key,
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            })
            .returning({ id: taskInstancesTable.id });

          if (inserted.length === 0) continue;

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_review_created",
            resourceType: "document",
            resourceId: doc.id,
            changes: { retentionDays: retentionDays, cutoff: cutoff.toISOString() },
          });

          totalHardDeleteTasksCreated++;
        }
      }

      // ── audit_log ────────────────────────────────────────────────────────
      // Audit log rows must NOT be auto-deleted (integrity of the audit trail).
      // Instead, create a single review task flagging how many rows are past
      // the retention window so an admin can approve manual export + archival.
      if (policy.recordType === "audit_log") {
        const [auditCount] = await db
          .select({ cnt: count() })
          .from(auditLogTable)
          .where(and(eq(auditLogTable.orgId, org.id), lt(auditLogTable.createdAt, cutoff)));

        const rowsOverWindow = Number(auditCount?.cnt ?? 0);
        if (rowsOverWindow > 0) {
          const taskTitle = `Audit log retention review: ${rowsOverWindow} records past ${retentionDays}-day window`;
          // Audit log review is rolled up per org (one task per org), so the
          // entity id in the dedup key is the org id itself.
          const key = retentionReviewKey("audit_log", org.id, "review");

          const inserted = await db
            .insert(taskInstancesTable)
            .values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `There are ${rowsOverWindow} audit log records older than ${retentionDays} days. Export and archive before any permanent deletion. Do NOT delete without a documented, approved archival process.`,
              status: "open",
              priority: "high",
              dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              createdBy: "system",
              retentionReviewKey: key,
            })
            .onConflictDoNothing({
              target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
              where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
            })
            .returning({ id: taskInstancesTable.id });

          if (inserted.length > 0) {
            totalHardDeleteTasksCreated++;
          }
        }
      }
    }
  }

  return { softDeleted: totalSoftDeleted, hardDeleteTasksCreated: totalHardDeleteTasksCreated };
}
