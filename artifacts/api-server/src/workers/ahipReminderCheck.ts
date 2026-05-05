/**
 * AHIP Reminder Check Worker.
 *
 * Runs monthly. Finds agents who have not completed AHIP for the current year
 * and sends reminder notifications + emails.
 */

import { and, eq, not, exists, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  ahipRecordsTable,
  usersTable,
  notificationsTable,
} from "@workspace/db";
import { type AhipReminderCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { ahipReminderEmailHtml } from "../lib/email";
import { logger } from "../lib/logger";

export async function ahipReminderCheckWorker(
  data: AhipReminderCheckPayload,
): Promise<void> {
  const year = data.certificationYear ?? new Date().getFullYear();

  const conditions = [
    eq(agentsTable.status, "active"),
    not(
      exists(
        db
          .select({ id: ahipRecordsTable.id })
          .from(ahipRecordsTable)
          .where(
            and(
              eq(ahipRecordsTable.agentId, agentsTable.id),
              eq(ahipRecordsTable.certificationYear, year),
              eq(ahipRecordsTable.status, "passed"),
            ),
          ),
      ),
    ),
  ];

  const agentsWithoutAhip = await db
    .select({
      id: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      email: agentsTable.email,
      orgId: agentsTable.orgId,
    })
    .from(agentsTable)
    .where(
      data.orgId
        ? and(...conditions, eq(agentsTable.orgId, data.orgId))
        : and(...conditions),
    );

  logger.info(
    { count: agentsWithoutAhip.length, year },
    "AHIP reminder check: agents without AHIP",
  );

  for (const agent of agentsWithoutAhip) {
    const orgAdmins = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, agent.orgId),
          sql`${usersTable.role} IN ('super_admin', 'agency_admin', 'compliance_manager')`,
          eq(usersTable.isActive, true),
        ),
      );

    const notifInserts = orgAdmins.map((admin) => ({
      id: randomUUID(),
      orgId: agent.orgId,
      userId: admin.id,
      type: "ahip_incomplete" as const,
      title: `AHIP ${year} not completed`,
      body: `${agent.firstName} ${agent.lastName} has not completed AHIP certification for ${year}`,
      resourceType: "agent",
      resourceId: agent.id,
      priority: "normal" as const,
    }));

    if (notifInserts.length > 0) {
      await db.insert(notificationsTable).values(notifInserts).onConflictDoNothing();
    }

    if (agent.email) {
      await enqueue(JOB_NAMES.SEND_EMAIL, {
        to: agent.email,
        subject: `AHIP ${year} certification reminder`,
        html: ahipReminderEmailHtml({
          agentName: `${agent.firstName} ${agent.lastName}`,
          certificationYear: year,
        }),
      });
    }
  }

  logger.info("AHIP reminder check worker complete");
}
