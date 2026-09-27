/**
 * Stage 2 "core pages" endpoints — auth, org scoping, permissions and the
 * happy path for:
 *   - GET /enrollments (book-of-business filters + names) and /enrollments/summary
 *   - GET /commissions/reconciliation/overview
 *   - GET /agents/me/backoffice and /agents/:id/backoffice
 *   - GET /reports/{contacts,policies,agents}/export (confirm gate, data_export_log,
 *     PHI masking identical to the existing contacts export)
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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentsTable,
  carriersTable,
  enrollmentsTable,
  commissionStatementsTable,
  commissionLineItemsTable,
  missedPaymentAlertsTable,
  stateLicensesTable,
  taskInstancesTable,
  documentsTable,
  dataExportLogTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";
import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let handle: TestDbHandle;

let org: { id: string };
let otherOrg: { id: string };
let superAdmin: { id: string };
let admin: { id: string };
let support: { id: string };
let viewer: { id: string };
let agentUser: { id: string };
let otherAdmin: { id: string };
let agent: { id: string };
let otherAgent: { id: string };
let contact: { id: string };
let contact2: { id: string };
let foreignContact: { id: string };
let carrierId: string;
let foreignCarrierId: string;

const MBI = "1EG4-TE5-MK73";

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;
  const db = handle.db;

  org = await seedOrg(db, { id: "s2core-org" });
  otherOrg = await seedOrg(db, { id: "s2core-other" });
  superAdmin = await seedUser(db, { orgId: org.id, role: "super_admin" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  support = await seedUser(db, { orgId: org.id, role: "agent_support" });
  viewer = await seedUser(db, { orgId: org.id, role: "viewer" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });

  agent = await seedAgent(db, { orgId: org.id, firstName: "Dana", lastName: "Reyes" });
  await db.update(agentsTable).set({ userId: agentUser.id }).where(eq(agentsTable.id, agent.id));
  otherAgent = await seedAgent(db, { orgId: otherOrg.id, firstName: "Foreign", lastName: "Agent" });

  contact = await seedContact(db, { orgId: org.id, firstName: "Mary", lastName: "Wilson", medicareId: MBI });
  contact2 = await seedContact(db, { orgId: org.id, firstName: "John", lastName: "Jones" });
  foreignContact = await seedContact(db, { orgId: otherOrg.id, firstName: "Other", lastName: "Tenant" });

  carrierId = `carrier-${randomUUID()}`;
  foreignCarrierId = `carrier-${randomUUID()}`;
  await db.insert(carriersTable).values([
    { id: carrierId, orgId: org.id, name: "Humana" },
    { id: foreignCarrierId, orgId: otherOrg.id, name: "Humana" },
  ]);

  await db.insert(enrollmentsTable).values([
    {
      id: `enr-${randomUUID()}`, orgId: org.id, contactId: contact.id, carrierId, agentId: agent.id,
      planType: "MAPD", planYear: 2026, effectiveDate: "2026-01-01", effectuated: true, status: "active",
      policyNumber: "POL-111",
    },
    {
      id: `enr-${randomUUID()}`, orgId: org.id, contactId: contact2.id, carrierId,
      planType: "PDP", planYear: 2026, effectiveDate: "2026-02-01", effectuated: false, status: "pending",
    },
    {
      id: `enr-${randomUUID()}`, orgId: otherOrg.id, contactId: foreignContact.id, carrierId: foreignCarrierId,
      planType: "MAPD", planYear: 2026, effectiveDate: "2026-01-01", status: "active",
    },
  ]);

  // Commission statement with a $10 variance and one unmatched line.
  const stmtId = `stmt-${randomUUID()}`;
  await db.insert(commissionStatementsTable).values({
    id: stmtId, orgId: org.id, carrierId, statementDate: "2026-03-01", periodStart: "2026-02-01",
    periodEnd: "2026-02-28", totalAmount: "310.00", source: "csv_upload", status: "parsed",
  });
  await db.insert(commissionLineItemsTable).values([
    {
      id: `li-${randomUUID()}`, statementId: stmtId, orgId: org.id, contactId: contact.id,
      policyNumber: "POL-111", commissionAmount: "200.00", type: "renewal", matchStatus: "matched",
      memberId: MBI,
    },
    {
      id: `li-${randomUUID()}`, statementId: stmtId, orgId: org.id, policyNumber: "POL-999",
      commissionAmount: "100.00", type: "initial", matchStatus: "unmatched", memberId: MBI,
    },
  ]);
  const foreignStmt = `stmt-${randomUUID()}`;
  await db.insert(commissionStatementsTable).values({
    id: foreignStmt, orgId: otherOrg.id, carrierId: foreignCarrierId, statementDate: "2026-03-01",
    periodStart: "2026-02-01", periodEnd: "2026-02-28", totalAmount: "999.00", source: "csv_upload", status: "parsed",
  });
  await db.insert(missedPaymentAlertsTable).values({
    id: `mp-${randomUUID()}`, orgId: org.id, contactId: contact2.id, policyNumber: "POL-222",
    expectedAmount: "25.50", expectedPeriod: "2026-02-01",
  });

  // Back-office data for `agent`.
  await db.insert(stateLicensesTable).values({
    id: `lic-${randomUUID()}`, agentId: agent.id, stateCode: "TX", licenseType: "health", status: "active",
  });
  await db.insert(taskInstancesTable).values({
    id: `task-${randomUUID()}`, orgId: org.id, agentId: agent.id, title: "Finish AHIP", status: "open",
  });
  await db.insert(documentsTable).values([
    { id: `doc-${randomUUID()}`, orgId: org.id, agentId: agent.id, name: "E&O certificate.pdf", storageKey: "k1" },
    { id: `doc-${randomUUID()}`, orgId: org.id, agentId: agent.id, contactId: contact.id, name: "client-soa.pdf", storageKey: "k2" },
  ]);
});

afterAll(async () => {
  await shutdownTestDb();
});

// ─── Policies (enrollments book of business) ─────────────────────────────

describe("GET /enrollments — book of business", () => {
  it("requires auth", async () => {
    expect((await request(app).get("/api/enrollments")).status).toBe(401);
  });

  it("forbids the agent role (no contact:read)", async () => {
    expect((await request(app).get("/api/enrollments").set(withAuth(agentUser.id))).status).toBe(403);
  });

  it("returns only the caller's org, with client, carrier and agent names", async () => {
    const res = await request(app).get("/api/enrollments").set(withAuth(viewer.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const mary = res.body.find((r: { contactId: string }) => r.contactId === contact.id);
    expect(mary.contactFirstName).toBe("Mary");
    expect(mary.carrierName).toBe("Humana");
    expect(mary.agentFirstName).toBe("Dana");
    expect(res.body.every((r: { orgId: string }) => r.orgId === org.id)).toBe(true);
  });

  it("filters by effectuated, plan type, agent, effective date and search", async () => {
    const h = withAuth(admin.id);
    const eff = await request(app).get("/api/enrollments?effectuated=false").set(h);
    expect(eff.body.map((r: { contactId: string }) => r.contactId)).toEqual([contact2.id]);

    const pdp = await request(app).get("/api/enrollments?planType=PDP").set(h);
    expect(pdp.body).toHaveLength(1);

    const byAgent = await request(app).get(`/api/enrollments?agentId=${agent.id}`).set(h);
    expect(byAgent.body.map((r: { contactId: string }) => r.contactId)).toEqual([contact.id]);

    const range = await request(app).get("/api/enrollments?effectiveFrom=2026-01-15&effectiveTo=2026-03-01").set(h);
    expect(range.body.map((r: { contactId: string }) => r.contactId)).toEqual([contact2.id]);

    const search = await request(app).get("/api/enrollments?search=wilson").set(h);
    expect(search.body.map((r: { contactId: string }) => r.contactId)).toEqual([contact.id]);

    const byPolicy = await request(app).get("/api/enrollments?search=POL-111").set(h);
    expect(byPolicy.body).toHaveLength(1);
  });

  it("summarises the org's book with the same filters", async () => {
    const res = await request(app).get("/api/enrollments/summary").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, active: 1, pending: 1, effectuated: 1, notEffectuated: 1 });

    const filtered = await request(app).get("/api/enrollments/summary?planType=PDP").set(withAuth(admin.id));
    expect(filtered.body.total).toBe(1);

    const foreign = await request(app).get("/api/enrollments/summary").set(withAuth(otherAdmin.id));
    expect(foreign.body.total).toBe(1);
  });
});

// ─── Reconciliation ──────────────────────────────────────────────────────

describe("GET /commissions/reconciliation/overview", () => {
  it("requires commission:read", async () => {
    expect((await request(app).get("/api/commissions/reconciliation/overview")).status).toBe(401);
    for (const u of [viewer, agentUser]) {
      const res = await request(app).get("/api/commissions/reconciliation/overview").set(withAuth(u.id));
      expect(res.status).toBe(403);
    }
  });

  it("reports variance, unmatched items and missed payments for the caller's org only", async () => {
    const res = await request(app).get("/api/commissions/reconciliation/overview").set(withAuth(support.id));
    expect(res.status).toBe(200);
    const { statements, totals, unmatchedItems, missedPayments } = res.body;

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      carrierName: "Humana", totalAmount: 310, lineItemTotal: 300, variance: 10, lineItemCount: 2, unmatchedCount: 1,
    });
    expect(totals).toMatchObject({
      statements: 1, lineItems: 2, matched: 1, unmatched: 1, unmatchedAmount: 100,
      statementsWithVariance: 1, varianceAmount: 10, openMissedPayments: 1, missedExpectedAmount: 25.5,
    });
    expect(unmatchedItems).toHaveLength(1);
    expect(unmatchedItems[0].policyNumber).toBe("POL-999");
    // Carrier member ids can be an MBI — never returned here.
    expect(JSON.stringify(res.body)).not.toContain(MBI);
    expect(missedPayments[0]).toMatchObject({ contactName: "John Jones", expectedAmount: 25.5 });
  });

  it("returns nothing from another org", async () => {
    const res = await request(app).get("/api/commissions/reconciliation/overview").set(withAuth(otherAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.statements).toHaveLength(1);
    expect(res.body.statements[0].totalAmount).toBe(999);
    expect(res.body.totals.openMissedPayments).toBe(0);
    expect(res.body.unmatchedItems).toHaveLength(0);
  });
});

// ─── Agent Back Office ───────────────────────────────────────────────────

describe("Agent back office", () => {
  it("lets an agent read their own back office via /me", async () => {
    const res = await request(app).get("/api/agents/me/backoffice").set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    expect(res.body.agent.id).toBe(agent.id);
    expect(res.body.licenses).toHaveLength(1);
    expect(res.body.tasks.map((t: { title: string }) => t.title)).toEqual(["Finish AHIP"]);
    // Only the agent's own paperwork — never client documents.
    expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(["E&O certificate.pdf"]);
    expect(res.body.complianceScore).toMatchObject({ activeLicenses: 1, totalLicenses: 1 });
    expect(res.body.readiness).not.toBeNull();
  });

  it("does not let an agent read someone else's back office by id", async () => {
    const res = await request(app).get(`/api/agents/${agent.id}/backoffice`).set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("404s /me when no agent is linked to the user", async () => {
    const res = await request(app).get("/api/agents/me/backoffice").set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });

  it("lets admins pick an agent in their org, and 404s a foreign agent", async () => {
    const ok = await request(app).get(`/api/agents/${agent.id}/backoffice`).set(withAuth(admin.id));
    expect(ok.status).toBe(200);
    expect(ok.body.agent.firstName).toBe("Dana");

    const foreign = await request(app).get(`/api/agents/${otherAgent.id}/backoffice`).set(withAuth(admin.id));
    expect(foreign.status).toBe(404);
  });
});

// ─── Data exports ────────────────────────────────────────────────────────

async function exportLogCount(type: string): Promise<number> {
  const rows = await handle.db
    .select()
    .from(dataExportLogTable)
    .where(and(eq(dataExportLogTable.orgId, org.id), eq(dataExportLogTable.exportType, type)));
  return rows.length;
}

describe("CSV exports", () => {
  it("requires the export confirmation header", async () => {
    for (const path of ["contacts", "policies", "agents"]) {
      const res = await request(app).get(`/api/reports/${path}/export`).set(withAuth(admin.id));
      expect(res.status).toBe(428);
    }
  });

  it("enforces permissions (viewer and agent cannot export)", async () => {
    for (const u of [viewer, agentUser]) {
      for (const path of ["contacts", "policies", "agents"]) {
        const res = await request(app)
          .get(`/api/reports/${path}/export`)
          .set(withAuth(u.id))
          .set("X-Confirm-Export", "true");
        expect(res.status).toBe(403);
      }
    }
    // agent_support may export contacts (same as the bulk export) but not the agent roster.
    const roster = await request(app)
      .get("/api/reports/agents/export")
      .set(withAuth(support.id))
      .set("X-Confirm-Export", "true");
    expect(roster.status).toBe(403);
  });

  it("exports contacts with the MBI decrypted only for PHI-privileged roles, and logs it", async () => {
    const before = await exportLogCount("contacts_csv");
    const priv = await request(app)
      .get("/api/reports/contacts/export")
      .set(withAuth(superAdmin.id))
      .set("X-Confirm-Export", "true");
    expect(priv.status).toBe(200);
    expect(priv.headers["content-type"]).toContain("text/csv");
    expect(priv.text).toContain("Mary");
    expect(priv.text).toContain(MBI);
    expect(priv.text).not.toContain("Other");

    const masked = await request(app)
      .get("/api/reports/contacts/export")
      .set(withAuth(support.id))
      .set("X-Confirm-Export", "true");
    expect(masked.status).toBe(200);
    expect(masked.text).not.toContain(MBI);
    expect(masked.text).toContain("***-**-****");

    expect(await exportLogCount("contacts_csv")).toBe(before + 2);
  });

  it("exports policies (no Medicare ID column) and agents, org-scoped and logged", async () => {
    const pol = await request(app)
      .get("/api/reports/policies/export")
      .set(withAuth(admin.id))
      .set("X-Confirm-Export", "true");
    expect(pol.status).toBe(200);
    expect(pol.text.split("\n")).toHaveLength(3); // header + 2 policies
    expect(pol.text).toContain("Mary Wilson");
    expect(pol.text).not.toContain("Other Tenant");
    expect(pol.text.toLowerCase()).not.toContain("medicare");
    expect(await exportLogCount("policies_csv")).toBe(1);

    const agents = await request(app)
      .get("/api/reports/agents/export")
      .set(withAuth(admin.id))
      .set("X-Confirm-Export", "true");
    expect(agents.status).toBe(200);
    expect(agents.text).toContain("Dana");
    expect(agents.text).not.toContain("Foreign");
    expect(await exportLogCount("agents_csv")).toBe(1);
  });
});
