/**
 * QA data/logic pass — every page must agree on the same numbers.
 *
 *   #2 licenses:   active = status active AND expiry in the future; a license
 *                  stored 'active' but past its expiry is expired EVERYWHERE
 *                  (licenses list, agent detail, agents list, readiness, back
 *                  office, dashboard, compliance alerts, reports).
 *   #3 leads:      dashboard "leads" = contacts at status Lead (the CRM's
 *                  number), not the inbound queue's `leads` table; reports
 *                  include records created today (inclusive end date).
 *   #4 plan:       /organizations/me reports the tier entitlements enforce —
 *                  the same one /billing/subscription reports.
 *   #5 statements: reconciled + variance ⇒ displayStatus
 *                  'reconciled_with_variance' in list, detail and overview;
 *                  the reconcile endpoint stamps reconciledAt.
 *   #6 AHIP:       Certifications and Renewals use one denominator (active +
 *                  onboarding) and one "complete" (passed or waived).
 *   #7 activity:   each dashboard activity carries its contact + actor names;
 *                  contact names only for roles with contact:read.
 *   #8 line items: contactName / writingAgentName for matched rows,
 *                  org-scoped, contact name gated on contact:read.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  clerkF: async (): Promise<Record<string, unknown>> => {
    const { clerkMockFactory } = await import("../helpers/testApp");
    return clerkMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentsTable,
  stateLicensesTable,
  ahipRecordsTable,
  contactsTable,
  leadsTable,
  activitiesTable,
  carriersTable,
  commissionStatementsTable,
  commissionLineItemsTable,
  organizationsTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth, withMfaAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

const DAY = 86_400_000;
const YEAR = new Date().getFullYear();
/** AHIP is counted for the plan year being sold (next year from Oct 1), on every screen. */
let AHIP_YEAR: number;

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let agentUser: { id: string };
let outsider: { id: string };

let expiredAgent: { id: string }; // one license, stored 'active', expired
let okAgent: { id: string }; // one current license
let onboardingAgent: { id: string };
let carrier: { id: string };
let cleanStmt: string;
let varianceStmt: string;
let parsedStmt: string;
let leadContact: { id: string };
let otherOrgContact: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "qa-org" });
  otherOrg = await seedOrg(testDb, { id: "qa-other-org" });
  // The legacy org column says "growth"; nothing enforces it.
  await testDb.update(organizationsTable).set({ planTier: "growth" }).where(eq(organizationsTable.id, org.id));
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin", fullName: "Marcus Lee" });
  agentUser = await seedUser(testDb, { orgId: org.id, role: "agent" });
  outsider = await seedUser(testDb, { orgId: otherOrg.id, role: "agency_admin" });

  // --- agents + licenses
  expiredAgent = await seedAgent(testDb, { orgId: org.id, firstName: "Linda", lastName: "Park" });
  okAgent = await seedAgent(testDb, { orgId: org.id, firstName: "Carlos", lastName: "Reyes" });
  onboardingAgent = await seedAgent(testDb, { orgId: org.id, firstName: "Olive", lastName: "New" });
  await testDb.update(agentsTable).set({ status: "active" }).where(eq(agentsTable.id, expiredAgent.id));
  await testDb.update(agentsTable).set({ status: "active" }).where(eq(agentsTable.id, okAgent.id));
  await testDb.update(agentsTable).set({ status: "onboarding" }).where(eq(agentsTable.id, onboardingAgent.id));
  await testDb.insert(stateLicensesTable).values([
    {
      id: `lic-${randomUUID()}`,
      agentId: expiredAgent.id,
      stateCode: "FL",
      licenseType: "health",
      status: "active", // stored active …
      expiryDate: new Date(Date.now() - 10 * DAY), // … but expired
    },
    {
      id: `lic-${randomUUID()}`,
      agentId: okAgent.id,
      stateCode: "CA",
      licenseType: "health",
      status: "active",
      expiryDate: new Date(Date.now() + 400 * DAY),
    },
  ]);

  AHIP_YEAR = (await import("../../lib/compliance/planYear")).sellingPlanYear();
  // --- AHIP: ok agent passed, onboarding agent waived, expired agent none.
  await testDb.insert(ahipRecordsTable).values([
    { id: `ahip-${randomUUID()}`, agentId: okAgent.id, certificationYear: AHIP_YEAR, status: "passed" },
    { id: `ahip-${randomUUID()}`, agentId: onboardingAgent.id, certificationYear: AHIP_YEAR, status: "waived" },
  ]);

  // --- contacts: 2 leads, 1 prospect, 1 enrolled; one lead soft-deleted.
  leadContact = await seedContact(testDb, { orgId: org.id, firstName: "Margaret", lastName: "Anderson", status: "lead" });
  await testDb.update(contactsTable).set({ assignedAgentId: okAgent.id }).where(eq(contactsTable.id, leadContact.id));
  await seedContact(testDb, { orgId: org.id, firstName: "Robert", lastName: "Brown", status: "lead" });
  await seedContact(testDb, { orgId: org.id, status: "prospect" });
  const member = await seedContact(testDb, { orgId: org.id, firstName: "Helen", lastName: "Young", status: "enrolled" });
  const gone = await seedContact(testDb, { orgId: org.id, status: "lead" });
  await testDb.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, gone.id));
  otherOrgContact = await seedContact(testDb, { orgId: otherOrg.id, firstName: "Other", lastName: "Org", status: "lead" });
  // A queue lead record (the other "lead" concept) — must not be what the
  // dashboard counts.
  await testDb.insert(leadsTable).values({ id: `lead-${randomUUID()}`, orgId: org.id, contactId: member.id, status: "new" });

  // --- activities
  await testDb.insert(activitiesTable).values([
    { id: `act-${randomUUID()}`, orgId: org.id, contactId: leadContact.id, type: "call_log", body: "Intro call", createdBy: admin.id },
    { id: `act-${randomUUID()}`, orgId: otherOrg.id, contactId: otherOrgContact.id, type: "note", body: "Other org note" },
  ]);

  // --- commission statements
  carrier = { id: `carrier-${randomUUID()}` };
  await testDb.insert(carriersTable).values({ id: carrier.id, orgId: org.id, name: "Humana" });
  cleanStmt = `stmt-${randomUUID()}`;
  varianceStmt = `stmt-${randomUUID()}`;
  parsedStmt = `stmt-${randomUUID()}`;
  const base = { orgId: org.id, carrierId: carrier.id, statementDate: "2026-08-05", periodStart: "2026-07-01", periodEnd: "2026-07-31", currency: "USD", source: "manual" };
  await testDb.insert(commissionStatementsTable).values([
    { ...base, id: cleanStmt, totalAmount: "200.00", status: "reconciled", reconciledAt: new Date("2026-08-07T00:00:00Z") },
    { ...base, id: varianceStmt, totalAmount: "1875.50", status: "reconciled" },
    { ...base, id: parsedStmt, totalAmount: "100.00", status: "parsed" },
  ]);
  const line = (statementId: string, amount: string, extra: Record<string, unknown> = {}) => ({
    id: `line-${randomUUID()}`,
    statementId,
    orgId: org.id,
    contactId: null as string | null,
    memberId: "MBR-1000",
    policyNumber: `POL-${randomUUID().slice(0, 6)}`,
    planType: "MAPD",
    planYear: YEAR,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    premium: "175.00",
    commissionAmount: amount,
    type: "renewal",
    writingAgentId: null as string | null,
    matchStatus: "unmatched",
    ...extra,
  });
  await testDb.insert(commissionLineItemsTable).values([
    line(cleanStmt, "200.00", { contactId: member.id, writingAgentId: okAgent.id, matchStatus: "matched" }),
    ...Array.from({ length: 4 }, () => line(varianceStmt, "612.50", { contactId: member.id, writingAgentId: okAgent.id, matchStatus: "matched" })),
    line(parsedStmt, "100.00"),
  ]);
});

afterAll(async () => {
  await shutdownTestDb();
});

const get = (path: string, userId: string = admin.id) => request(app).get(path).set(withAuth(userId));

describe("#2 one license definition across pages", () => {
  it("licenses list stamps effectiveStatus = expired on a past-expiry 'active' license", async () => {
    const res = await get(`/api/agents/${expiredAgent.id}/licenses`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe("active");
    expect(res.body.data[0].effectiveStatus).toBe("expired");
    const ok = await get(`/api/agents/${okAgent.id}/licenses`);
    expect(ok.body.data[0].effectiveStatus).toBe("active");
  });

  it("agent detail and agents list count 0 active for the expired agent", async () => {
    const detail = await get(`/api/agents/${expiredAgent.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.licensesCount).toBe(1);
    expect(detail.body.activeLicensesCount).toBe(0);
    const list = await get(`/api/agents?limit=50`);
    const rows = list.body.agents as Array<{ id: string; activeLicenseCount?: number }>;
    expect(rows.find((a) => a.id === expiredAgent.id)?.activeLicenseCount ?? 0).toBe(0);
    expect(rows.find((a) => a.id === okAgent.id)?.activeLicenseCount).toBe(1);
  });

  it("readiness says the license expired (not 'no license') and agrees with licensing", async () => {
    const res = await get(`/api/agents/readiness`);
    expect(res.status).toBe(200);
    const a = res.body.data.find((x: { agentId: string }) => x.agentId === expiredAgent.id);
    expect(a.licensedStates).toEqual([]);
    expect(a.blockers).toContain("State license expired");
    const b = res.body.data.find((x: { agentId: string }) => x.agentId === okAgent.id);
    expect(b.licensedStates).toEqual(["CA"]);
  });

  it("back office licenses carry the same effectiveStatus", async () => {
    const res = await get(`/api/agents/${expiredAgent.id}/backoffice`);
    expect(res.status).toBe(200);
    expect(res.body.licenses[0].effectiveStatus).toBe("expired");
  });

  it("dashboard and compliance alerts count the expired license", async () => {
    const dash = await get(`/api/dashboard/stats`);
    expect(dash.status).toBe(200);
    expect(dash.body.licensesExpiredCount).toBe(1);
    expect(dash.body.licensesExpiringIn90Days).toBe(0);
    const alerts = await get(`/api/compliance-alerts`);
    expect(alerts.status).toBe(200);
    expect(alerts.body.licenses.expired).toBe(1);
    const row = alerts.body.topAgents.find((r: { agentId: string }) => r.agentId === expiredAgent.id);
    expect(row.licensesExpired).toBe(1);
  });

  it("agent-performance report uses the same active count", async () => {
    const res = await get(`/api/reports/agent-performance`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((r: { agentId: string }) => [r.agentId, r]));
    expect((byId.get(expiredAgent.id) as { licensesActive: number }).licensesActive).toBe(0);
    expect((byId.get(okAgent.id) as { licensesActive: number }).licensesActive).toBe(1);
  });
});

describe("#3 one lead definition", () => {
  it("dashboard openLeadsCount = contacts at status Lead (not the queue table, not deleted, not other orgs)", async () => {
    const res = await get(`/api/dashboard/stats`);
    expect(res.body.openLeadsCount).toBe(2);
    const crm = await get(`/api/contacts?status=lead&limit=1`);
    expect(crm.status).toBe(200);
    expect(crm.body.total).toBe(2);
    // totalContacts excludes the soft-deleted one.
    expect(res.body.totalContacts).toBe(4);
  });

  it("executive report counts contacts created today when endDate is today (inclusive)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    const res = await get(`/api/reports/executive?startDate=${start}&endDate=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.leads.total).toBe(4);
  });

  it("leaderboard reports CRM leads per agent alongside the queue workload", async () => {
    const res = await get(`/api/agents/leaderboard`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: { agentId: string }) => r.agentId === okAgent.id);
    expect(row.leadContacts).toBe(1);
    expect(row.openLeads).toBe(0);
  });
});

describe("#4 one plan source", () => {
  it("/organizations/me reports the entitlement tier, same as /billing/subscription", async () => {
    const org1 = await get(`/api/organizations/me`);
    const sub = await get(`/api/billing/subscription`);
    expect(org1.status).toBe(200);
    expect(sub.status).toBe(200);
    expect(org1.body.planTier).toBe(sub.body.tier);
  });
});

describe("#5 statement status never shows reconciled when totals disagree", () => {
  it("list marks the variance statement 'reconciled_with_variance'", async () => {
    const res = await get(`/api/commissions/statements`);
    expect(res.status).toBe(200);
    const by = new Map(res.body.map((s: { id: string }) => [s.id, s]));
    const v = by.get(varianceStmt) as { displayStatus: string; variance: number; status: string };
    expect(v.status).toBe("reconciled");
    expect(v.variance).toBe(-574.5);
    expect(v.displayStatus).toBe("reconciled_with_variance");
    expect((by.get(cleanStmt) as { displayStatus: string }).displayStatus).toBe("reconciled");
    expect((by.get(parsedStmt) as { displayStatus: string }).displayStatus).toBe("parsed");
  });

  it("detail carries displayStatus, variance and reconciledAt", async () => {
    const v = await get(`/api/commissions/statements/${varianceStmt}`);
    expect(v.body.displayStatus).toBe("reconciled_with_variance");
    expect(v.body.lineItemTotal).toBe(2450);
    const c = await get(`/api/commissions/statements/${cleanStmt}`);
    expect(c.body.displayStatus).toBe("reconciled");
    expect(c.body.reconciledAt).toBeTruthy();
  });

  it("reconciliation overview does not count a variance statement as cleanly reconciled", async () => {
    const res = await get(`/api/commissions/reconciliation/overview`);
    expect(res.status).toBe(200);
    expect(res.body.totals.statementsReconciled).toBe(1);
    expect(res.body.totals.statementsReconciledWithVariance).toBe(1);
    const row = res.body.statements.find((s: { id: string }) => s.id === varianceStmt);
    expect(row.displayStatus).toBe("reconciled_with_variance");
  });

  it("the reconcile endpoint stamps reconciledAt", async () => {
    const res = await request(app)
      .post(`/api/commissions/statements/${parsedStmt}/reconcile`)
      .set(withMfaAuth(admin.id, true));
    expect(res.status).toBe(200);
    const [row] = await testDb.select().from(commissionStatementsTable).where(eq(commissionStatementsTable.id, parsedStmt));
    expect(row!.status).toBe("reconciled");
    expect(row!.reconciledAt).toBeInstanceOf(Date);
  });

  it("other orgs cannot read the statement", async () => {
    const res = await get(`/api/commissions/statements/${varianceStmt}`, outsider.id);
    expect(res.status).toBe(404);
  });
});

describe("#6 one AHIP definition", () => {
  it("certifications and renewals agree: active + onboarding agents, passed or waived", async () => {
    const ahip = await get(`/api/ahip/dashboard?year=${AHIP_YEAR}`);
    const alerts = await get(`/api/compliance-alerts`);
    expect(ahip.status).toBe(200);
    expect(ahip.body.agentsRequiringAhip).toBe(3);
    expect(ahip.body.totalActiveAgents).toBe(3);
    expect(ahip.body.passedCount).toBe(2); // passed + waived
    expect(alerts.body.ahip.totalActiveAgents).toBe(ahip.body.agentsRequiringAhip);
    expect(alerts.body.ahip.passed).toBe(ahip.body.passedCount);
    const dash = await get(`/api/dashboard/stats`);
    expect(dash.body.agentsRequiringAhip).toBe(3);
    expect(dash.body.ahipCompleteCount).toBe(2);
    expect(dash.body.ahipCompletionRateCurrent).toBe(ahip.body.completionRate);
  });
});

describe("#7 dashboard activity", () => {
  it("names the contact and the actor; org-scoped", async () => {
    const res = await get(`/api/dashboard/activity`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].contactName).toBe("Margaret Anderson");
    expect(res.body[0].userFullName).toBe("Marcus Lee");
  });

  it("hides the contact name from a role without contact:read", async () => {
    const res = await get(`/api/dashboard/activity`, agentUser.id);
    expect(res.status).toBe(200);
    expect(res.body[0].contactName).toBeNull();
    expect(res.body[0].resourceId).toBeNull();
  });
});

describe("#8 statement line items", () => {
  it("returns contact and writing-agent names for matched rows, null for unmatched", async () => {
    const res = await get(`/api/commissions/statements/${cleanStmt}/line-items`);
    expect(res.status).toBe(200);
    expect(res.body[0].contactName).toBe("Helen Young");
    expect(res.body[0].writingAgentName).toBe("Carlos Reyes");
    const un = await get(`/api/commissions/statements/${parsedStmt}/line-items`);
    expect(un.body[0].contactName).toBeNull();
    expect(un.body[0].writingAgentName).toBeNull();
  });

  it("is org-scoped", async () => {
    const res = await get(`/api/commissions/statements/${cleanStmt}/line-items`, outsider.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
