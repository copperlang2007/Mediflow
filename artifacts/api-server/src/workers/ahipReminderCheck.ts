/**
 * AHIP Reminder Check Worker.
 *
 * Runs monthly. Finds agents who have not completed AHIP for the upcoming plan
 * year (the AHIP season always certifies for next year's plans — see
 * lib/compliance/planYear.ts) and sends reminder notifications + emails.
 */

import { and, eq, inArray, not, exists, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  ahipRecordsTable,
  usersTable,
  notificationsTable,
  orgSettingsTable,
} from "@workspace/db";
import { type AhipDeadlineCheckPayload, enqueue, JOB_NAMES } from "../lib/jobs";
import { ahipReminderEmailHtml } from "../lib/email";
import { broadcastToUsers } from "../lib/sseManager";
import { logger } from "../lib/logger";
import { ahipSeasonPlanYear } from "../lib/compliance/planYear";

export async function ahipReminderCheckWorker(
  data: AhipDeadlineCheckPayload,
): Promise<void> {
  const year = data.certificationYear ?? ahipSeasonPlanYear();

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
              // Same rule as the compliance score and readiness gate.
              inArray(ahipRecordsTable.status, ["passed", "waived"]),
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

  // Cache org settings to avoid N+1 queries
  const orgSettingsCache = new Map<
    string,
    {
      ahipSeasonOpenMonth: number;
      ahipSeasonOpenDay: number;
      ahipDeadlineMonth: number;
      ahipDeadlineDay: number;
      ahipReminderEnabled: boolean;
    }
  >();

  const today = new Date();
  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();

  async function getOrgSettings(orgId: string) {
    if (orgSettingsCache.has(orgId)) return orgSettingsCache.get(orgId)!;
    const [s] = await db
      .select()
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.orgId, orgId))
      .limit(1);
    const defaults = {
      ahipSeasonOpenMonth: s?.ahipSeasonOpenMonth ?? 7,
      ahipSeasonOpenDay: s?.ahipSeasonOpenDay ?? 1,
      ahipDeadlineMonth: s?.ahipDeadlineMonth ?? 12,
      ahipDeadlineDay: s?.ahipDeadlineDay ?? 7,
      ahipReminderEnabled: s?.ahipReminderEnabled ?? true,
    };
    orgSettingsCache.set(orgId, defaults);
    return defaults;
  }

  // Check each org for season-open day trigger (fire once on the opening day itself)
  const orgIds = [...new Set(agentsWithoutAhip.map((a) => a.orgId))];
  if (data.orgId && !orgIds.includes(data.orgId)) orgIds.push(data.orgId);

  for (const orgId of orgIds) {
    const settings = await getOrgSettings(orgId);
    if (!settings.ahipReminderEnabled) continue;
    const isSeasonOpenDay =
      todayMonth === settings.ahipSeasonOpenMonth && todayDay === settings.ahipSeasonOpenDay;
    if (!isSeasonOpenDay) continue;

    const admins = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.orgId, orgId),
          sql`${usersTable.role} IN ('super_admin', 'agency_admin', 'compliance_manager')`,
          eq(usersTable.isActive, true),
        ),
      );

    const seasonNotifs = admins.map((a) => ({
      id: randomUUID(),
      orgId,
      userId: a.id,
      type: "ahip_season_open" as const,
      title: `AHIP ${year} enrollment season is now open`,
      body: `The AHIP certification season for ${year} opened today. Agents can now complete their certification.`,
      resourceType: "org",
      resourceId: orgId,
      priority: "normal" as const,
    }));

    if (seasonNotifs.length > 0) {
      await db.insert(notificationsTable).values(seasonNotifs).onConflictDoNothing();
      broadcastToUsers(
        seasonNotifs.map((n) => n.userId),
        { type: "notification", resourceType: "org", resourceId: orgId },
      );
      await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
        to: admins.flatMap((a) => (a.email ? [a.email] : [])),
        subject: `AHIP ${year} enrollment season is now open`,
        html: `<p>The AHIP certification season for ${year} is now open. Please remind your agents to complete their AHIP certification before the deadline.</p>`,
      });
      logger.info({ orgId, year }, "AHIP season-open alert sent");
    }
  }

  for (const agent of agentsWithoutAhip) {
    const orgSettings = await getOrgSettings(agent.orgId);

    if (!orgSettings.ahipReminderEnabled) continue;

    // Only send reminders if we are within the configured AHIP season window
    const afterOpen =
      todayMonth > orgSettings.ahipSeasonOpenMonth ||
      (todayMonth === orgSettings.ahipSeasonOpenMonth && todayDay >= orgSettings.ahipSeasonOpenDay);
    const beforeDeadline =
      todayMonth < orgSettings.ahipDeadlineMonth ||
      (todayMonth === orgSettings.ahipDeadlineMonth && todayDay <= orgSettings.ahipDeadlineDay);

    if (!afterOpen || !beforeDeadline) {
      logger.debug(
        { agentId: agent.id, orgId: agent.orgId, todayMonth, todayDay },
        "AHIP reminder skipped: outside configured season window",
      );
      continue;
    }
    const orgAdmins = await db
      .select({ id: usersTable.id, email: usersTable.email })
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
      broadcastToUsers(
        notifInserts.map((n) => n.userId),
        { type: "notification", resourceType: "agent", resourceId: agent.id },
      );
    }

    // Send AHIP reminder to agent AND all compliance managers
    const ahipEmailHtml = ahipReminderEmailHtml({
      agentName: `${agent.firstName} ${agent.lastName}`,
      certificationYear: year,
    });
    const emailRecipients: string[] = [];
    if (agent.email) emailRecipients.push(agent.email);
    orgAdmins.forEach((a) => { if (a.email) emailRecipients.push(a.email); });

    if (emailRecipients.length > 0) {
      await enqueue(JOB_NAMES.SEND_SCHEDULED_EMAIL, {
        to: emailRecipients,
        subject: `AHIP ${year} certification reminder — ${agent.firstName} ${agent.lastName}`,
        html: ahipEmailHtml,
      });
    }
  }

  logger.info("AHIP reminder check worker complete");
}
