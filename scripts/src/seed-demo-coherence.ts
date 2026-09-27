/**
 * Demo coherence pass — the parts of the demo agency that make the other
 * pages non-empty and consistent with each other:
 *
 *   - contacts' plan year = the current year; members carry their carrier
 *   - one current-year enrollment (policy) per member (14) → /policies
 *   - AHIP + carrier certifications for the current year (Carlos ready to sell,
 *     Linda still in progress)
 *   - AEP annual-review tasks via the PRODUCTION generator → /aep
 *   - 3 appointments, 3 Knowledge Base articles, 1 automation rule,
 *     1 document record, 1 SMS thread, agent presence
 *   - commission follow-ups hung off the seeded statements: reconciled-at
 *     times, agent payouts, 2 missed-payment alerts
 *
 * Everything is clearly fictional (example.com / 555 numbers / "demo" in
 * ids and titles). Every write is keyed on a stable id (or a natural unique
 * key) with onConflictDoNothing, or is a guarded one-time update of a legacy
 * demo value — so running it on every boot is a no-op once applied and it
 * never overwrites edits made while demoing.
 *
 * Only ever called from seed-demo.ts, after assertSafeToSeed() — it inherits
 * that script's production guards and never runs on its own.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  carriersTable,
  contactsTable,
  enrollmentsTable,
  ahipRecordsTable,
  carrierCertificationsTable,
  appointmentsTable,
  kbArticlesTable,
  automationRulesTable,
  documentsTable,
  messageThreadsTable,
  messagesTable,
  agentPresenceTable,
  taskInstancesTable,
  commissionStatementsTable,
  commissionLineItemsTable,
  agentCommissionPayoutsTable,
  stateLicensesTable,
  activitiesTable,
  missedPaymentAlertsTable,
} from "@workspace/db";
import { generateAepRenewalTasks } from "@workspace/api-server/lib/aepRenewal/generate";
import {
  DEMO_ORG_ID,
  USERS,
  stableId,
  COMMISSION_STATEMENT_SLUGS,
  COMMISSION_LINES_PER_STATEMENT,
} from "./demo-constants";
import {
  ACTIVITY_SCRIPT,
  DEMO_AGENTS,
  DEMO_LICENSES,
  LEGACY_ACTIVITY_BODIES,
  LEGACY_LICENSE_EXPIRY,
  MEMBER_CARRIERS,
  demoContact,
  demoContacts,
  demoMembers,
  demoPolicyNumber,
  type DemoContact,
} from "./demo-contacts";

type Log = (...parts: unknown[]) => void;

const DAY = 86_400_000;

export function currentPlanYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The two commission periods the demo statements cover: the month before
 * last, and last month. Statement date = 5 days after period end, never in
 * the future.
 */
export function demoPeriods(now: Date = new Date()): Array<{
  statementDate: string;
  periodStart: string;
  periodEnd: string;
}> {
  return [2, 1].map((monthsAgo) => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 0));
    const stmt = new Date(Math.min(end.getTime() + 5 * DAY, now.getTime()));
    return { statementDate: isoDate(stmt), periodStart: isoDate(start), periodEnd: isoDate(end) };
  });
}

/** Effective date of a member's current-year plan (never in the future). */
function effectiveDate(c: DemoContact, year: number, now: Date): string {
  if (c.status === "retained") return `${year}-01-01`;
  // Newly enrolled members: staggered first-of-month effective dates.
  const month = Math.min(1 + (c.index % 6), now.getUTCMonth() + 1);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export async function seedDemoCoherence(log: Log): Promise<void> {
  const now = new Date();
  const year = currentPlanYear(now);

  // Guard: only run once the core rows exist (a partially-seeded org resumes
  // through seedAll first).
  const agents = await db
    .select({ id: agentsTable.id, userId: agentsTable.userId })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, DEMO_ORG_ID), inArray(agentsTable.id, Object.values(DEMO_AGENTS))));
  const carriers = await db
    .select({ id: carriersTable.id, name: carriersTable.name })
    .from(carriersTable)
    .where(eq(carriersTable.orgId, DEMO_ORG_ID));
  const contactRows = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.orgId, DEMO_ORG_ID), inArray(contactsTable.id, demoContacts().map((c) => c.id))));
  if (agents.length < 2 || carriers.length === 0 || contactRows.length === 0) {
    log("[coherence] core demo rows not present yet — skipping");
    return;
  }
  const present = new Set(contactRows.map((r) => r.id));
  const carrierId = (name: string | null): string | null =>
    (name && carriers.find((c) => c.name === name)?.id) || null;
  const members = demoMembers().filter((m) => present.has(m.id));

  // 1. Contacts: legacy demo rows were stamped plan year 2025 and had
  //    members assigned to Linda (who can't have written business yet).
  //    One-time fix, keyed on that legacy value so later edits survive.
  for (const c of demoContacts()) {
    if (!present.has(c.id)) continue;
    await db
      .update(contactsTable)
      .set({
        planYear: year,
        currentPlanType: c.planType,
        assignedAgentId: c.assignedAgentId,
        ...(c.isMember ? { currentCarrierId: carrierId(c.carrierName) } : {}),
      })
      .where(and(eq(contactsTable.id, c.id), eq(contactsTable.orgId, DEMO_ORG_ID), eq(contactsTable.planYear, 2025)));
    if (c.isMember) {
      await db
        .update(contactsTable)
        .set({ currentCarrierId: carrierId(c.carrierName) })
        .where(and(eq(contactsTable.id, c.id), eq(contactsTable.orgId, DEMO_ORG_ID), isNull(contactsTable.currentCarrierId)));
    }
  }

  // 1b. Legacy fixes for demos seeded by the original script: every license
  //     had the same hard-coded expiry (all expired by now), and the six
  //     activities repeated three bodies. Keyed on those legacy values.
  for (const l of DEMO_LICENSES) {
    await db
      .update(stateLicensesTable)
      .set({ expiryDate: new Date(now.getTime() + l.expiresInDays * DAY) })
      .where(
        and(
          eq(stateLicensesTable.id, stableId("license", `${l.agentId}-${l.state}`)),
          eq(stateLicensesTable.expiryDate, new Date(LEGACY_LICENSE_EXPIRY)),
        ),
      );
  }
  for (let i = 0; i < ACTIVITY_SCRIPT.length; i++) {
    const c = demoContact(i);
    const script = ACTIVITY_SCRIPT[i]!;
    await db
      .update(activitiesTable)
      .set({
        body: script.body,
        type: script.type,
        agentId: c.assignedAgentId,
        createdBy: c.assignedAgentId === DEMO_AGENTS.linda ? USERS.lindaUser : USERS.carlosUser,
      })
      .where(
        and(
          eq(activitiesTable.id, stableId("activity", `${c.id}-${i}`)),
          eq(activitiesTable.orgId, DEMO_ORG_ID),
          inArray(activitiesTable.body, LEGACY_ACTIVITY_BODIES),
        ),
      );
  }

  // 2. One current-year enrollment (policy) per member → /policies, /aep.
  for (const m of members) {
    const eff = effectiveDate(m, year, now);
    await db
      .insert(enrollmentsTable)
      .values({
        id: stableId("enrollment", `${m.id}:${year}`),
        orgId: DEMO_ORG_ID,
        contactId: m.id,
        carrierId: carrierId(m.carrierName),
        agentId: DEMO_AGENTS.carlos,
        planName: `${m.carrierName} ${m.planType === "supp" ? "Medicare Supplement Plan G" : m.planType === "PDP" ? "Rx Saver (PDP)" : m.planType === "MAPD" ? "Choice Plus (HMO)" : "Value (HMO)"} — demo`,
        planType: m.planType,
        planYear: year,
        policyNumber: demoPolicyNumber(m, year),
        applicationDate: isoDate(new Date(new Date(`${eff}T00:00:00Z`).getTime() - 25 * DAY)),
        effectiveDate: eff,
        effectuated: true,
        status: "active",
        notes: "Fictional demo policy.",
      })
      .onConflictDoNothing();
  }

  // 3. AHIP + carrier certifications for the current year.
  const certYear = year;
  await db
    .insert(ahipRecordsTable)
    .values([
      {
        id: stableId("ahip", `${DEMO_AGENTS.carlos}:${certYear}`),
        agentId: DEMO_AGENTS.carlos,
        certificationYear: certYear,
        status: "passed",
        score: 94,
        completedDate: new Date(Date.UTC(certYear, 6, 15)),
      },
      {
        id: stableId("ahip", `${DEMO_AGENTS.linda}:${certYear}`),
        agentId: DEMO_AGENTS.linda,
        certificationYear: certYear,
        status: "in_progress",
      },
    ])
    .onConflictDoNothing();
  for (const name of MEMBER_CARRIERS) {
    const cid = carrierId(name);
    if (!cid) continue;
    await db
      .insert(carrierCertificationsTable)
      .values({
        id: stableId("cert", `${DEMO_AGENTS.carlos}:${cid}:${certYear}`),
        agentId: DEMO_AGENTS.carlos,
        carrierId: cid,
        certificationYear: certYear,
        status: "passed",
        completedDate: new Date(Date.UTC(certYear, 6, 20)),
        expiryDate: new Date(Date.UTC(certYear, 11, 31, 23, 59, 59)),
        score: 90,
      })
      .onConflictDoNothing();
  }

  // 4. AEP annual-review tasks through the production generator (idempotent
  //    per (year, contact)). Two are marked done so the cockpit shows progress.
  await generateAepRenewalTasks({ orgId: DEMO_ORG_ID, now });
  const aepDone = members.filter((m) => m.planType === "MA" || m.planType === "MAPD").slice(0, 2);
  if (aepDone.length > 0) {
    await db
      .update(taskInstancesTable)
      .set({ status: "completed", completedAt: new Date(now.getTime() - 3 * DAY) })
      .where(
        and(
          eq(taskInstancesTable.orgId, DEMO_ORG_ID),
          inArray(
            taskInstancesTable.autoAssignTrigger,
            aepDone.map((m) => `aep_renewal:${year}:${m.id}`),
          ),
          isNull(taskInstancesTable.completedAt),
          eq(taskInstancesTable.status, "open"),
        ),
      );
  }

  // 5. Appointments — two upcoming annual reviews, one completed consultation.
  const reviewA = members.find((m) => m.planType === "MA") ?? members[0];
  const reviewB = members.find((m) => m.planType === "MAPD") ?? members[1];
  const prospect = demoContact(1); // a prospect
  const at = (days: number, hourUtc: number) => {
    const d = new Date(now.getTime() + days * DAY);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d;
  };
  const appts = [
    reviewA && { key: "review-a", contact: reviewA, type: "review" as const, status: "confirmed" as const, start: at(3, 15), loc: "phone" as const, title: `Annual plan review — ${reviewA.firstName} ${reviewA.lastName}` },
    reviewB && { key: "review-b", contact: reviewB, type: "review" as const, status: "pending" as const, start: at(6, 18), loc: "video" as const, title: `Annual plan review — ${reviewB.firstName} ${reviewB.lastName}` },
    present.has(prospect.id) && { key: "consult", contact: prospect, type: "consultation" as const, status: "completed" as const, start: at(-5, 16), loc: "office" as const, title: `Medicare options consultation — ${prospect.firstName} ${prospect.lastName}` },
  ].filter(Boolean) as Array<{ key: string; contact: DemoContact; type: "review" | "consultation"; status: "confirmed" | "pending" | "completed"; start: Date; loc: "phone" | "video" | "office"; title: string }>;
  for (const a of appts) {
    await db
      .insert(appointmentsTable)
      .values({
        id: stableId("appointment", a.key),
        orgId: DEMO_ORG_ID,
        contactId: a.contact.id,
        agentId: DEMO_AGENTS.carlos,
        type: a.type,
        title: a.title,
        startsAt: a.start,
        endsAt: new Date(a.start.getTime() + 45 * 60_000),
        status: a.status,
        locationType: a.loc,
        locationDetail: a.loc === "office" ? "INSUREitALL Demo office (fictional)" : null,
        createdBy: USERS.carlosUser,
      })
      .onConflictDoNothing();
  }

  // 6. Knowledge Base — internal how-tos (demo content, no regulatory claims
  //    beyond widely published CMS dates).
  const kb = [
    {
      key: "aep-dates",
      category: "Enrollment periods",
      title: "AEP at a glance (demo article)",
      content:
        "The Annual Enrollment Period runs October 15 – December 7. Plan details for next year are available from October 1, so book every current member's annual review before then. Changes made during AEP take effect January 1.\n\nThis is a sample article in the demo agency.",
      keywords: ["AEP", "annual enrollment", "dates", "renewal"],
    },
    {
      key: "annual-review",
      category: "Client service",
      title: "Running an annual plan review (demo article)",
      content:
        "1. Confirm the member's doctors and pharmacies are still in network.\n2. Review their prescriptions against next year's formulary.\n3. Compare premiums, copays and the out-of-pocket maximum.\n4. Record the outcome as a note on the client and close the review task.\n\nThis is a sample article in the demo agency.",
      keywords: ["review", "retention", "formulary", "network"],
    },
    {
      key: "new-lead",
      category: "Sales",
      title: "Working a new lead (demo article)",
      content:
        "Call new leads within one business day. Log every call on the client record, set the next step as a task, and follow your agency's compliance process before discussing specific plans.\n\nThis is a sample article in the demo agency.",
      keywords: ["lead", "follow-up", "first call"],
    },
  ];
  for (const a of kb) {
    await db
      .insert(kbArticlesTable)
      .values({
        id: stableId("kb", a.key),
        orgId: DEMO_ORG_ID,
        category: a.category,
        title: a.title,
        content: a.content,
        keywords: a.keywords,
        isActive: true,
        createdBy: USERS.agencyAdmin,
      })
      .onConflictDoNothing();
  }

  // 7. One automation rule — the same shape the rule builder saves.
  await db
    .insert(automationRulesTable)
    .values({
      id: stableId("automation", "new-lead-call-task"),
      orgId: DEMO_ORG_ID,
      name: "Call every new lead within a day",
      triggerType: "contact_created",
      triggerConfig: {},
      conditions: [{ field: "status", operator: "eq", value: "lead", logic: "and" }],
      actions: [
        {
          type: "create_task",
          config: { title: "Call new lead", dueOffsetDays: 1, priority: "high" },
        },
      ],
      isActive: true,
    })
    .onConflictDoNothing();

  // 8. One document record. No file is uploaded (the demo has no object
  //    storage), and the name says so.
  await db
    .insert(documentsTable)
    .values({
      id: stableId("document", "carlos-eo"),
      orgId: DEMO_ORG_ID,
      agentId: DEMO_AGENTS.carlos,
      name: "E&O certificate — Carlos Reyes (demo record, no file stored)",
      category: "compliance",
      storageKey: "demo/not-stored/carlos-eo-certificate.pdf",
      mimeType: "application/pdf",
      uploadedBy: USERS.agencyAdmin,
    })
    .onConflictDoNothing();

  // 9. One SMS thread with a member, about their upcoming review.
  if (reviewA) {
    const threadId = stableId("thread", `${reviewA.id}:sms`);
    const phone = `+1555${String(5550000 + reviewA.index).slice(-7)}`.slice(0, 12);
    const t0 = now.getTime() - 26 * 3_600_000;
    await db
      .insert(messageThreadsTable)
      .values({ id: threadId, orgId: DEMO_ORG_ID, contactId: reviewA.id, channel: "sms", lastMessageAt: new Date(t0 + 2 * 3_600_000) })
      .onConflictDoNothing();
    const msgs = [
      { k: "1", direction: "outbound" as const, status: "delivered" as const, body: `Hi ${reviewA.firstName}, it's Carlos from INSUREitALL Demo. Time for your annual plan review — does ${at(3, 15).toUTCString().slice(0, 11)} work for a quick call?`, at: t0 },
      { k: "2", direction: "inbound" as const, status: "received" as const, body: "Yes, that works. Morning is best for me.", at: t0 + 3_600_000 },
      { k: "3", direction: "outbound" as const, status: "delivered" as const, body: "You're booked. I'll call you then — have your prescription list handy.", at: t0 + 2 * 3_600_000 },
    ];
    for (const m of msgs) {
      await db
        .insert(messagesTable)
        .values({
          id: stableId("message", `${threadId}:${m.k}`),
          threadId,
          direction: m.direction,
          body: m.body,
          fromAddress: m.direction === "outbound" ? "+15555550100" : phone,
          toAddress: m.direction === "outbound" ? phone : "+15555550100",
          status: m.status,
          sentAt: new Date(m.at),
          createdAt: new Date(m.at),
        })
        .onConflictDoNothing();
    }
  }

  // 10. Presence — Carlos available (no auto-expiry, so the demo wallboard
  //     has someone online), Linda offline.
  await db
    .insert(agentPresenceTable)
    .values([
      { agentId: DEMO_AGENTS.carlos, orgId: DEMO_ORG_ID, status: "available", source: "heartbeat", lastSeenAt: now, expiresAt: null },
      { agentId: DEMO_AGENTS.linda, orgId: DEMO_ORG_ID, status: "offline", source: "heartbeat", lastSeenAt: new Date(now.getTime() - 2 * DAY), expiresAt: null },
    ])
    .onConflictDoNothing();

  await seedCommissionFollowups(log, members, year);

  log(
    `[coherence] ensured ${members.length} policies, AHIP/certs, AEP tasks, ${appts.length} appointments, ` +
      `${kb.length} KB articles, 1 rule, 1 document, 1 SMS thread, presence`,
  );
}

/**
 * Payouts, missed-payment alerts and reconcile times for the seeded
 * statements. Skipped until the statements exist.
 */
async function seedCommissionFollowups(log: Log, members: DemoContact[], year: number): Promise<void> {
  const stmtIds = COMMISSION_STATEMENT_SLUGS.map((slug) => stableId("stmt", slug));
  const statements = await db
    .select()
    .from(commissionStatementsTable)
    .where(and(eq(commissionStatementsTable.orgId, DEMO_ORG_ID), inArray(commissionStatementsTable.id, stmtIds)));
  if (statements.length === 0) return;

  // Reconcile time for demo statements seeded before reconciled_at existed.
  for (const s of statements) {
    if (s.status === "reconciled" && !s.reconciledAt) {
      await db
        .update(commissionStatementsTable)
        .set({ reconciledAt: new Date(new Date(`${s.statementDate}T00:00:00Z`).getTime() + 2 * DAY) })
        .where(eq(commissionStatementsTable.id, s.id));
    }
  }

  // Legacy demo lines paid commission on leads/prospects (the first four
  // contacts). Re-point those at members holding a policy with that carrier.
  const legacyContactIds = [0, 1, 2, 3].map((i) => demoContact(i).id);
  const carriers = await db
    .select({ id: carriersTable.id, name: carriersTable.name })
    .from(carriersTable)
    .where(eq(carriersTable.orgId, DEMO_ORG_ID));
  for (const s of statements) {
    const carrierName = carriers.find((c) => c.id === s.carrierId)?.name;
    const payable = members.filter((m) => m.carrierName === carrierName);
    for (let i = 0; i < COMMISSION_LINES_PER_STATEMENT; i++) {
      const member = payable[i % Math.max(1, payable.length)] ?? members[i];
      if (!member) continue;
      await db
        .update(commissionLineItemsTable)
        .set({ contactId: member.id, policyNumber: demoPolicyNumber(member, year), planType: member.planType })
        .where(
          and(
            eq(commissionLineItemsTable.id, stableId("line", `${s.id}-${i}`)),
            eq(commissionLineItemsTable.orgId, DEMO_ORG_ID),
            inArray(commissionLineItemsTable.contactId, legacyContactIds),
          ),
        );
    }
  }

  // Payouts: one per (writing agent, statement period), earned = the sum of
  // that agent's lines. The older period is paid, the newest still open.
  const sums = await db
    .select({
      agentId: commissionLineItemsTable.writingAgentId,
      periodStart: commissionStatementsTable.periodStart,
      periodEnd: commissionStatementsTable.periodEnd,
      statementDate: commissionStatementsTable.statementDate,
      earned: sql<string>`sum(${commissionLineItemsTable.commissionAmount})::text`,
    })
    .from(commissionLineItemsTable)
    .innerJoin(commissionStatementsTable, eq(commissionStatementsTable.id, commissionLineItemsTable.statementId))
    .where(and(eq(commissionLineItemsTable.orgId, DEMO_ORG_ID), inArray(commissionStatementsTable.id, stmtIds)))
    .groupBy(
      commissionLineItemsTable.writingAgentId,
      commissionStatementsTable.periodStart,
      commissionStatementsTable.periodEnd,
      commissionStatementsTable.statementDate,
    );
  const latestStart = sums.map((r) => r.periodStart).sort().at(-1);
  for (const r of sums) {
    if (!r.agentId) continue;
    const isLatest = r.periodStart === latestStart && sums.some((x) => x.periodStart !== latestStart);
    const paidAt = new Date(new Date(`${r.statementDate}T00:00:00Z`).getTime() + 10 * DAY);
    await db
      .insert(agentCommissionPayoutsTable)
      .values({
        id: stableId("payout", `${r.agentId}:${r.periodStart}:${r.periodEnd}`),
        orgId: DEMO_ORG_ID,
        agentId: r.agentId,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        earned: r.earned,
        paid: isLatest ? "0" : r.earned,
        status: isLatest ? "open" : "paid",
        paidAt: isLatest ? null : paidAt,
        paidByUserId: isLatest ? null : USERS.agencyAdmin,
      })
      .onConflictDoNothing();
  }

  // Missed payments: two members whose carrier sent no line for them on the
  // most recent statement period.
  const latest = [...statements].sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0]!;
  const paidContactIds = new Set(
    (
      await db
        .select({ contactId: commissionLineItemsTable.contactId })
        .from(commissionLineItemsTable)
        .where(eq(commissionLineItemsTable.statementId, latest.id))
    ).map((r) => r.contactId),
  );
  const unpaid = members.filter((m) => !paidContactIds.has(m.id) && (m.planType === "MA" || m.planType === "MAPD")).slice(0, 2);
  for (const m of unpaid) {
    await db
      .insert(missedPaymentAlertsTable)
      .values({
        id: stableId("missed", `${m.id}:${latest.periodStart}`),
        orgId: DEMO_ORG_ID,
        contactId: m.id,
        policyNumber: demoPolicyNumber(m, year),
        expectedAmount: "612.50",
        expectedPeriod: latest.periodStart,
        detectedAt: new Date(new Date(`${latest.statementDate}T00:00:00Z`).getTime() + DAY),
      })
      .onConflictDoNothing();
  }
  log(`[coherence] commission follow-ups: ${sums.length} payouts, ${unpaid.length} missed-payment alerts`);
}
