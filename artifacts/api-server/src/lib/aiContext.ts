/**
 * Context builders for AI assistant system prompts.
 * Each function queries the DB for the relevant record and returns a
 * structured context string injected into the OpenAI system prompt.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  taskInstancesTable,
  contactsTable,
  activitiesTable,
  sequenceEnrollmentsTable,
  sequencesTable,
  organizationsTable,
  leadsTable,
} from "@workspace/db";

// ---- Agent context ----

export async function buildAgentContext(agentId: string, orgId: string): Promise<string> {
  const [agent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId))).limit(1);
  if (!agent) return `Agent ID ${agentId} not found.`;

  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 86400000);

  const [licenses, certs, ahip, overdueTasks] = await Promise.all([
    db.select().from(stateLicensesTable).where(eq(stateLicensesTable.agentId, agentId)).limit(20),
    db.select().from(carrierCertificationsTable).where(eq(carrierCertificationsTable.agentId, agentId)).limit(20),
    db.select().from(ahipRecordsTable).where(eq(ahipRecordsTable.agentId, agentId)).orderBy(desc(ahipRecordsTable.certificationYear)).limit(1),
    db.select().from(taskInstancesTable).where(and(eq(taskInstancesTable.agentId, agentId), eq(taskInstancesTable.status, "open"), sql`${taskInstancesTable.dueDate} < ${now.toISOString()}::timestamptz`)).limit(10),
  ]);

  const expiringLicenses = licenses.filter((l) => l.expiryDate && new Date(l.expiryDate) <= in90);
  const expiringCerts = certs.filter((c) => c.completedDate && new Date(c.completedDate) <= in90);
  const latestAhip = ahip[0];

  return [
    `AGENT COMPLIANCE SNAPSHOT`,
    `Name: ${agent.firstName} ${agent.lastName}`,
    `Email: ${agent.email}`,
    `Status: ${agent.status}`,
    `NPN: ${agent.npn ?? "not set"}`,
    `Hire date: ${agent.hireDate ?? "not set"}`,
    ``,
    `Licenses (${licenses.length} total, ${expiringLicenses.length} expiring within 90 days):`,
    ...expiringLicenses.map((l) => `  ⚠ ${l.stateCode} ${l.licenseType} — expires ${l.expiryDate}`),
    ``,
    `Carrier Certifications (${certs.length} total, ${expiringCerts.length} needing renewal):`,
    ...expiringCerts.map((c) => `  ⚠ ${c.carrierId} — year ${c.certificationYear} — status ${c.status}`),
    ``,
    `AHIP: ${latestAhip ? `${latestAhip.status} for ${latestAhip.certificationYear}` : "no AHIP record"}`,
    ``,
    `Overdue tasks (${overdueTasks.length}):`,
    ...overdueTasks.map((t) => `  • ${t.title} (due ${t.dueDate})`),
  ].join("\n");
}

// ---- Contact context ----

export async function buildContactContext(contactId: string, orgId: string): Promise<string> {
  const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId))).limit(1);
  if (!contact) return `Contact ID ${contactId} not found.`;

  const [activities, enrollments] = await Promise.all([
    db.select().from(activitiesTable).where(eq(activitiesTable.contactId, contactId)).orderBy(desc(activitiesTable.createdAt)).limit(5),
    db.select({ enrollment: sequenceEnrollmentsTable, sequenceName: sequencesTable.name })
      .from(sequenceEnrollmentsTable)
      .innerJoin(sequencesTable, eq(sequenceEnrollmentsTable.sequenceId, sequencesTable.id))
      .where(and(eq(sequenceEnrollmentsTable.contactId, contactId), eq(sequenceEnrollmentsTable.status, "active")))
      .limit(3),
  ]);

  const lastActivity = activities[0];

  return [
    `CONTACT MEDICARE PROFILE`,
    `Name: ${contact.firstName} ${contact.lastName}`,
    `Email: ${contact.email ?? "not set"}`,
    `Phone: ${contact.phone ?? "not set"}`,
    `Status: ${contact.status}`,
    `Date of birth: ${contact.dob ?? "not set"}`,
    `Medicare ID: ${contact.medicareId ?? "not set"}`,
    `Plan type: ${contact.currentPlanType ?? "not set"}`,
    `Carrier ID: ${contact.currentCarrierId ?? "not set"}`,
    `County: ${contact.county ?? "not set"}`,
    `Tags: ${(contact.tags ?? []).join(", ") || "none"}`,
    ``,
    `Last interaction: ${lastActivity ? `${lastActivity.type} — ${lastActivity.createdAt}` : "never"}`,
    `Active sequences: ${enrollments.length > 0 ? enrollments.map((e) => e.sequenceName).join(", ") : "none"}`,
    ``,
    `Recent activity:`,
    ...activities.map((a) => `  • [${a.type}] ${a.body ?? ""} — ${a.createdAt}`),
  ].join("\n");
}

// ---- Dashboard context ----

export async function buildDashboardContext(orgId: string): Promise<string> {
  const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400000);

  const [agentCounts, expLicenses, contactCounts, newLeads] = await Promise.all([
    db.select({ status: agentsTable.status, count: sql<number>`count(*)` }).from(agentsTable).where(eq(agentsTable.orgId, orgId)).groupBy(agentsTable.status),
    db.select({ count: sql<number>`count(*)` }).from(stateLicensesTable).innerJoin(agentsTable, eq(stateLicensesTable.agentId, agentsTable.id)).where(and(eq(agentsTable.orgId, orgId), sql`${stateLicensesTable.expiryDate} <= ${in30.toISOString()}::timestamptz`, sql`${stateLicensesTable.expiryDate} >= ${now.toISOString()}::timestamptz`)),
    db.select({ status: contactsTable.status, count: sql<number>`count(*)` }).from(contactsTable).where(eq(contactsTable.orgId, orgId)).groupBy(contactsTable.status),
    db.select({ count: sql<number>`count(*)` }).from(leadsTable).where(and(eq(leadsTable.orgId, orgId), sql`${leadsTable.createdAt} >= (now() - interval '30 days')`)),
  ]);

  const activeAgents = agentCounts.find((a) => a.status === "active")?.count ?? 0;
  const totalAgents = agentCounts.reduce((sum, a) => sum + Number(a.count), 0);

  return [
    `AGENCY DASHBOARD SUMMARY`,
    `Organization: ${org?.name ?? orgId}`,
    ``,
    `Agents: ${totalAgents} total, ${activeAgents} active`,
    `Licenses expiring in 30 days: ${expLicenses[0]?.count ?? 0}`,
    ``,
    `Contacts by status:`,
    ...contactCounts.map((c) => `  ${c.status}: ${c.count}`),
    ``,
    `New leads in last 30 days: ${newLeads[0]?.count ?? 0}`,
  ].join("\n");
}
