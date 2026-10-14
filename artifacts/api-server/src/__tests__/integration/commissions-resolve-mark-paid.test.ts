/**
 * POST /api/commissions/missed-payments/:id/resolve and
 * POST /api/agents/:id/commissions/:periodId/mark-paid.
 *
 * The commissions page's "Mark resolved" and the agent Commissions tab's
 * "Mark paid" buttons called these, but neither existed. Both are
 * org-scoped, gated on `commission:update` (+ MFA) like the other
 * commission writes, and audit-logged by the commissions router.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, authF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  authF: async (): Promise<Record<string, unknown>> => {
    const { identityMockFactory } = await import("../helpers/testApp");
    return identityMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentCommissionPayoutsTable,
  auditLogTable,
  carriersTable,
  commissionStatementsTable,
  missedPaymentAlertsTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let support: { id: string };
let otherAdmin: { id: string };
let agentId: string;
let otherAgentId: string;

async function seedAlert(orgId: string, contactId: string, policyNumber: string): Promise<string> {
  const id = `mpa-${randomUUID()}`;
  await testDb.insert(missedPaymentAlertsTable).values({
    id,
    orgId,
    contactId,
    policyNumber,
    expectedAmount: "42.00",
    expectedPeriod: "2025-04-01",
    detectedAt: new Date(Date.now() - 10 * 86_400_000),
  });
  return id;
}

async function seedPayout(orgId: string, agent: string, periodStart: string, earned: string): Promise<string> {
  const id = `payout-${randomUUID()}`;
  const [y, m] = periodStart.split("-").map(Number);
  const periodEnd = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  await testDb.insert(agentCommissionPayoutsTable).values({
    id,
    orgId,
    agentId: agent,
    periodStart,
    periodEnd,
    earned,
    paid: "0",
    status: "open",
  });
  return id;
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb);
  otherOrg = await seedOrg(testDb);
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  // agent_support can read commissions but not write them.
  support = await seedUser(testDb, { orgId: org.id, role: "agent_support" });
  otherAdmin = await seedUser(testDb, { orgId: otherOrg.id, role: "agency_admin" });
  agentId = (await seedAgent(testDb, { orgId: org.id })).id;
  otherAgentId = (await seedAgent(testDb, { orgId: org.id })).id;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/commissions/missed-payments", () => {
  it("returns open alerts with contact name and days overdue", async () => {
    const contact = await seedContact(testDb, { orgId: org.id });
    const id = await seedAlert(org.id, contact.id, "POL-LIST");
    const res = await request(app)
      .get("/api/commissions/missed-payments")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { id: string }) => r.id === id);
    expect(row).toBeDefined();
    expect(row.contactName).toBeTruthy();
    expect(row.daysOverdue).toBeGreaterThanOrEqual(9);
    expect(row.expectedPeriodStart).toBe("2025-04-01");
    expect(row.expectedPeriodEnd).toBe("2025-04-30");
  });
});

describe("POST /api/commissions/missed-payments/:id/resolve", () => {
  it("resolves an open alert, stores the note, drops it from the open list and audit-logs it", async () => {
    const contact = await seedContact(testDb, { orgId: org.id });
    const id = await seedAlert(org.id, contact.id, "POL-RES");

    const res = await request(app)
      .post(`/api/commissions/missed-payments/${id}/resolve`)
      .set(withAuth(admin.id))
      .send({ note: "Carrier paid next cycle" });
    expect(res.status).toBe(200);
    expect(res.body.resolutionNote).toBe("Carrier paid next cycle");
    expect(res.body.resolvedAt).toBeTruthy();

    const list = await request(app)
      .get("/api/commissions/missed-payments")
      .set(withAuth(admin.id));
    expect(list.body.some((r: { id: string }) => r.id === id)).toBe(false);

    const resolved = await request(app)
      .get("/api/commissions/missed-payments?status=resolved")
      .set(withAuth(admin.id));
    expect(resolved.body.some((r: { id: string }) => r.id === id)).toBe(true);

    // The audit write happens on response finish; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const audits = await testDb
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.orgId, org.id), eq(auditLogTable.resourceType, "commission")));
    expect(
      audits.some((a) => String((a.changes as { path?: string })?.path ?? "").includes(`${id}/resolve`)),
    ).toBe(true);
  });

  it("409s when resolving twice", async () => {
    const contact = await seedContact(testDb, { orgId: org.id });
    const id = await seedAlert(org.id, contact.id, "POL-TWICE");
    const first = await request(app)
      .post(`/api/commissions/missed-payments/${id}/resolve`)
      .set(withAuth(admin.id))
      .send({});
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/commissions/missed-payments/${id}/resolve`)
      .set(withAuth(admin.id))
      .send({ note: "again" });
    expect(second.status).toBe(409);
  });

  it("404s for another org's alert and leaves it untouched", async () => {
    const contact = await seedContact(testDb, { orgId: org.id });
    const id = await seedAlert(org.id, contact.id, "POL-XORG");
    const res = await request(app)
      .post(`/api/commissions/missed-payments/${id}/resolve`)
      .set(withAuth(otherAdmin.id))
      .send({ note: "nope" });
    expect(res.status).toBe(404);
    const [row] = await testDb
      .select()
      .from(missedPaymentAlertsTable)
      .where(eq(missedPaymentAlertsTable.id, id));
    expect(row?.resolvedAt).toBeNull();
  });

  it("403s for a role without commission:update", async () => {
    const contact = await seedContact(testDb, { orgId: org.id });
    const id = await seedAlert(org.id, contact.id, "POL-403");
    const res = await request(app)
      .post(`/api/commissions/missed-payments/${id}/resolve`)
      .set(withAuth(support.id))
      .send({});
    expect(res.status).toBe(403);
  });

  it("401s without auth", async () => {
    const res = await request(app).post("/api/commissions/missed-payments/x/resolve").send({});
    expect(res.status).toBe(401);
  });

  it("400s on an over-long note", async () => {
    const contact = await seedContact(testDb, { orgId: org.id });
    const id = await seedAlert(org.id, contact.id, "POL-400");
    const res = await request(app)
      .post(`/api/commissions/missed-payments/${id}/resolve`)
      .set(withAuth(admin.id))
      .send({ note: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/commissions/statements", () => {
  it("includes the carrier name for each statement, org-scoped", async () => {
    const carrierId = `carrier-${randomUUID()}`;
    await testDb.insert(carriersTable).values({ id: carrierId, orgId: org.id, name: "Wellcare", isActive: true });
    const stmtId = `stmt-${randomUUID()}`;
    await testDb.insert(commissionStatementsTable).values({
      id: stmtId,
      orgId: org.id,
      carrierId,
      statementDate: "2025-04-15",
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      totalAmount: "10.00",
      currency: "USD",
      source: "csv_upload",
      status: "parsed",
    });
    const res = await request(app).get("/api/commissions/statements").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.find((s: { id: string }) => s.id === stmtId)?.carrierName).toBe("Wellcare");

    const other = await request(app).get("/api/commissions/statements").set(withAuth(otherAdmin.id));
    expect(other.body.some((s: { id: string }) => s.id === stmtId)).toBe(false);
  });
});

describe("POST /api/agents/:id/commissions/:periodId/mark-paid", () => {
  it("marks an open payout paid (paid = earned) and the tab summary reflects it", async () => {
    const payoutId = await seedPayout(org.id, agentId, "2025-06-01", "210.50");

    const before = await request(app)
      .get(`/api/agents/${agentId}/commissions`)
      .set(withAuth(admin.id));
    expect(before.status).toBe(200);
    expect(before.body.periods.find((p: { id: string }) => p.id === payoutId)?.status).toBe("open");
    expect(before.body.pendingPayouts).toBeGreaterThanOrEqual(210.5);

    const res = await request(app)
      .post(`/api/agents/${agentId}/commissions/${payoutId}/mark-paid`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(Number(res.body.paid)).toBeCloseTo(210.5, 2);
    expect(res.body.paidByUserId).toBe(admin.id);
    expect(res.body.paidAt).toBeTruthy();

    const again = await request(app)
      .post(`/api/agents/${agentId}/commissions/${payoutId}/mark-paid`)
      .set(withAuth(admin.id));
    expect(again.status).toBe(409);
  });

  it("404s when the payout belongs to a different agent", async () => {
    const payoutId = await seedPayout(org.id, otherAgentId, "2025-07-01", "10.00");
    const res = await request(app)
      .post(`/api/agents/${agentId}/commissions/${payoutId}/mark-paid`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });

  it("404s for another org's admin", async () => {
    const payoutId = await seedPayout(org.id, agentId, "2025-08-01", "10.00");
    const res = await request(app)
      .post(`/api/agents/${agentId}/commissions/${payoutId}/mark-paid`)
      .set(withAuth(otherAdmin.id));
    expect(res.status).toBe(404);
    const [row] = await testDb
      .select()
      .from(agentCommissionPayoutsTable)
      .where(eq(agentCommissionPayoutsTable.id, payoutId));
    expect(row?.status).toBe("open");
  });

  it("403s for a role without commission:update", async () => {
    const payoutId = await seedPayout(org.id, agentId, "2025-09-01", "10.00");
    const res = await request(app)
      .post(`/api/agents/${agentId}/commissions/${payoutId}/mark-paid`)
      .set(withAuth(support.id));
    expect(res.status).toBe(403);
  });
});
