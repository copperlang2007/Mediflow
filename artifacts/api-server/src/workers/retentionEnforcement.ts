/**
 * Retention Enforcement Worker
 *
 * Runs daily at 02:00 UTC via pg-boss schedule.
 *
 * For each organisation with an enabled data retention policy:
 *  1. Soft-delete active records whose createdAt has passed the retention window
 *     and create a "retention_review" task so an admin can confirm hard-deletion.
 *  2. For records that are already soft-deleted and have passed the retention window,
 *     create a separate hard-delete review task prompting permanent removal.
 *
 * Supported record types: contacts, deals
 */

import { and, count, eq, isNull, isNotNull, lt } from "drizzle-orm";
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

// Full set of retention policy types configured in the admin UI
const SUPPORTED_RECORD_TYPES = ["contacts", "deals", "agents", "communications", "documents", "audit_log"] as const;
type SupportedRecordType = (typeof SUPPORTED_RECORD_TYPES)[number];

export async function retentionEnforcementWorker(): Promise<void> {
  logger.info("retention-enforcement: starting run");

  const orgs = await db.select({ id: organizationsTable.id }).from(organizationsTable);

  let totalSoftDeleted = 0;
  let totalHardDeleteTasksCreated = 0;

  for (const org of orgs) {
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

      const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);

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
            ),
          );

        for (const contact of expired) {
          await db
            .update(contactsTable)
            .set({ deletedAt: new Date() })
            .where(eq(contactsTable.id, contact.id));

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: `Retention review: contact ${contact.firstName} ${contact.lastName}`,
            description: `Contact soft-deleted by automated retention policy (${policy.retentionDays} days). Review and confirm hard delete or restore.`,
            status: "open",
            priority: "medium",
            dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_soft_delete",
            resourceType: "contact",
            resourceId: contact.id,
            changes: { retentionDays: policy.retentionDays, cutoff: cutoff.toISOString() },
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
          const [existingTask] = await db
            .select({ id: taskInstancesTable.id })
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.orgId, org.id), eq(taskInstancesTable.title, taskTitle), eq(taskInstancesTable.status, "open")))
            .limit(1);
          if (existingTask) continue;

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: taskTitle,
            description: `Contact was soft-deleted and has now exceeded the ${policy.retentionDays}-day retention window. Approve permanent deletion via Admin > Compliance > Data Retention.`,
            status: "open",
            priority: "high",
            dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_hard_delete_review_created",
            resourceType: "contact",
            resourceId: contact.id,
            changes: { retentionDays: policy.retentionDays, deletedAt: contact.deletedAt?.toISOString() },
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

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: `Retention review: deal "${deal.title}"`,
            description: `Deal soft-deleted by automated retention policy (${policy.retentionDays} days). Review and confirm hard delete or restore.`,
            status: "open",
            priority: "medium",
            dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_soft_delete",
            resourceType: "deal",
            resourceId: deal.id,
            changes: { retentionDays: policy.retentionDays, cutoff: cutoff.toISOString() },
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
          const [existingTask] = await db
            .select({ id: taskInstancesTable.id })
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.orgId, org.id), eq(taskInstancesTable.title, taskTitle), eq(taskInstancesTable.status, "open")))
            .limit(1);
          if (existingTask) continue;

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: taskTitle,
            description: `Deal was soft-deleted and has now exceeded the ${policy.retentionDays}-day retention window. Approve permanent deletion via Admin > Compliance > Data Retention.`,
            status: "open",
            priority: "high",
            dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_hard_delete_review_created",
            resourceType: "deal",
            resourceId: deal.id,
            changes: { retentionDays: policy.retentionDays, deletedAt: deal.deletedAt?.toISOString() },
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
          const [existing] = await db
            .select({ id: taskInstancesTable.id })
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.orgId, org.id), eq(taskInstancesTable.title, taskTitle), eq(taskInstancesTable.status, "open")))
            .limit(1);
          if (existing) continue;

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: taskTitle,
            description: `Agent record has existed for more than ${policy.retentionDays} days. Review per data retention policy and determine if the record should be purged, anonymised, or retained.`,
            status: "open",
            priority: "medium",
            dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_review_created",
            resourceType: "agent",
            resourceId: agent.id,
            changes: { retentionDays: policy.retentionDays, cutoff: cutoff.toISOString() },
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
          const [existing] = await db
            .select({ id: taskInstancesTable.id })
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.orgId, org.id), eq(taskInstancesTable.title, taskTitle), eq(taskInstancesTable.status, "open")))
            .limit(1);
          if (existing) continue;

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: taskTitle,
            description: `Communication thread has exceeded the ${policy.retentionDays}-day retention window. Review and purge if required by policy.`,
            status: "open",
            priority: "medium",
            dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_review_created",
            resourceType: "communication",
            resourceId: thread.id,
            changes: { retentionDays: policy.retentionDays, cutoff: cutoff.toISOString() },
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
          const [existing] = await db
            .select({ id: taskInstancesTable.id })
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.orgId, org.id), eq(taskInstancesTable.title, taskTitle), eq(taskInstancesTable.status, "open")))
            .limit(1);
          if (existing) continue;

          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: taskTitle,
            description: `Document "${doc.name}" (${doc.category}) has exceeded the ${policy.retentionDays}-day retention window. Review and purge if required by policy.`,
            status: "open",
            priority: "medium",
            dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            createdBy: "system",
          });

          await db.insert(auditLogTable).values({
            id: randomUUID(),
            orgId: org.id,
            userId: "system",
            action: "retention_review_created",
            resourceType: "document",
            resourceId: doc.id,
            changes: { retentionDays: policy.retentionDays, cutoff: cutoff.toISOString() },
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
          const taskTitle = `Audit log retention review: ${rowsOverWindow} records past ${policy.retentionDays}-day window`;
          const [existing] = await db
            .select({ id: taskInstancesTable.id })
            .from(taskInstancesTable)
            .where(and(eq(taskInstancesTable.orgId, org.id), eq(taskInstancesTable.title, taskTitle), eq(taskInstancesTable.status, "open")))
            .limit(1);

          if (!existing) {
            await db.insert(taskInstancesTable).values({
              id: randomUUID(),
              orgId: org.id,
              title: taskTitle,
              description: `There are ${rowsOverWindow} audit log records older than ${policy.retentionDays} days. Export and archive before any permanent deletion. Do NOT delete without a documented, approved archival process.`,
              status: "open",
              priority: "high",
              dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              createdBy: "system",
            });

            totalHardDeleteTasksCreated++;
          }
        }
      }
    }
  }

  logger.info(
    { totalSoftDeleted, totalHardDeleteTasksCreated },
    "retention-enforcement: run complete",
  );
}
