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

import { and, eq, isNull, isNotNull, lt } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  organizationsTable,
  dataRetentionPoliciesTable,
  contactsTable,
  dealsTable,
  taskInstancesTable,
  auditLogTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const SUPPORTED_RECORD_TYPES = ["contacts", "deals"] as const;
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
          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: `Hard-delete approval required: contact ${contact.firstName} ${contact.lastName}`,
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
          await db.insert(taskInstancesTable).values({
            id: randomUUID(),
            orgId: org.id,
            title: `Hard-delete approval required: deal "${deal.title}"`,
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
    }
  }

  logger.info(
    { totalSoftDeleted, totalHardDeleteTasksCreated },
    "retention-enforcement: run complete",
  );
}
