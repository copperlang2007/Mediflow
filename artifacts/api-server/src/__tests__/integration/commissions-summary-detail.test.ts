/**
 * GET /api/commissions/summary and GET /api/commissions/statements/:id.
 *
 * The commissions page's stat cards and the statement detail page called
 * these, but neither existed (404 -> "—" everywhere / "Statement not found").
 * Both are org-scoped and gated on `commission:read`.
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
import {
  agentCommissionPayoutsTable,
  carriersTable,
  commissionLineItemsTable,
  commissionStatementsTable,
  missedPaymentAlertsTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  seedContact,
  type TestDb,
} from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let viewer: { id: string };
let otherAdmin: { id: string };
let statementId: string;
let otherStatementId: string;

async function seedCarrier(orgId: string, name: string): Promise<string> {
  const id = `carrier-${randomUUID()}`;
  await testDb.insert(carriersTable).values({ id, orgId, name, isActive: true });
  return id;
}

async function seedStatement(orgId: string, carrierId: string): Promise<string> {
  const id = `stmt-${randomUUID()}`;
  await testDb.insert(commissionStatementsTable).values({
    id,
    orgId,
    carrierId,
    statementDate: "2025-04-15",
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    totalAmount: "1000.00",
    currency: "USD",
    source: "csv_upload",
    status: "parsed",
  });
  return id;
}

async function seedLine(
  orgId: string,
  stmt: string,
  matchStatus: "matched" | "unmatched" | "manual",
): Promise<void> {
  await testDb.insert(commissionLineItemsTable).values({
    id: `li-${randomUUID()}`,
    statementId: stmt,
    orgId,
    commissionAmount: "50.00",
    type: "renewal",
    matchStatus,
  });
}

async function seedPayout(opts: {
  orgId: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  earned: string;
  paid?: string;
  status?: string;
}): Promise<void> {
  await testDb.insert(agentCommissionPayoutsTable).values({
    id: `payout-${randomUUID()}`,
    orgId: opts.orgId,
    agentId: opts.agentId,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    earned: opts.earned,
    paid: opts.paid ?? "0",
    status: opts.status ?? "open",
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb);
  otherOrg = await seedOrg(testDb);
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  viewer = await seedUser(testDb, { orgId: org.id, role: "viewer" });
  otherAdmin = await seedUser(testDb, { orgId: otherOrg.id, role: "agency_admin" });

  const carrierId = await seedCarrier(org.id, "Aetna");
  statementId = await seedStatement(org.id, carrierId);
  await seedLine(org.id, statementId, "matched");
  await seedLine(org.id, statementId, "manual");
  await seedLine(org.id, statementId, "unmatched");

  const otherCarrier = await seedCarrier(otherOrg.id, "Humana");
  otherStatementId = await seedStatement(otherOrg.id, otherCarrier);

  const a1 = await seedAgent(testDb, { orgId: org.id });
  const a2 = await seedAgent(testDb, { orgId: org.id });
  // April 2025 (the latest period): one paid, one open.
  await seedPayout({
    orgId: org.id,
    agentId: a1.id,
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    earned: "300.00",
    paid: "300.00",
    status: "paid",
  });
  await seedPayout({
    orgId: org.id,
    agentId: a2.id,
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    earned: "125.50",
  });
  // An older period that must not be counted in April.
  await seedPayout({
    orgId: org.id,
    agentId: a1.id,
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    earned: "999.00",
  });

  // One open and one resolved missed-payment alert.
  const contact = await seedContact(testDb, { orgId: org.id });
  await testDb.insert(missedPaymentAlertsTable).values([
    {
      id: `mpa-${randomUUID()}`,
      orgId: org.id,
      contactId: contact.id,
      policyNumber: "POL-1",
      expectedPeriod: "2025-04-01",
    },
    {
      id: `mpa-${randomUUID()}`,
      orgId: org.id,
      contactId: contact.id,
      policyNumber: "POL-2",
      expectedPeriod: "2025-04-01",
      resolvedAt: new Date(),
    },
  ]);

  // Other org's payouts must not leak.
  const otherAgent = await seedAgent(testDb, { orgId: otherOrg.id });
  await seedPayout({
    orgId: otherOrg.id,
    agentId: otherAgent.id,
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    earned: "5000.00",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/commissions/statements/:id", () => {
  it("returns the statement with carrier name and match counts", async () => {
    const res = await request(app)
      .get(`/api/commissions/statements/${statementId}`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: statementId,
      orgId: org.id,
      carrierName: "Aetna",
      status: "parsed",
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      lineItemCount: 3,
      matchedCount: 2,
      unmatchedCount: 1,
    });
  });

  it("404s for another org's statement", async () => {
    const res = await request(app)
      .get(`/api/commissions/statements/${otherStatementId}`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });

  it("403s for a role without commission:read", async () => {
    const res = await request(app)
      .get(`/api/commissions/statements/${statementId}`)
      .set(withAuth(viewer.id));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/commissions/summary", () => {
  it("defaults to the latest payout period", async () => {
    const res = await request(app)
      .get("/api/commissions/summary")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      period: "2025-04",
      periodLabel: "April 2025",
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      earnedThisPeriod: 425.5,
      paidThisPeriod: 300,
      pendingThisPeriod: 125.5,
      agentsOnPayouts: 2,
      missedPaymentsCount: 1,
    });
  });

  it("honours an explicit period", async () => {
    const res = await request(app)
      .get("/api/commissions/summary?period=2025-03")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.earnedThisPeriod).toBe(999);
    expect(res.body.pendingThisPeriod).toBe(999);
    expect(res.body.agentsOnPayouts).toBe(1);
  });

  it("returns zeros (not an error) for an org with no payouts", async () => {
    const res = await request(app)
      .get("/api/commissions/summary?period=2020-01")
      .set(withAuth(otherAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.earnedThisPeriod).toBe(0);
    expect(res.body.missedPaymentsCount).toBe(0);
  });

  it("rejects a malformed period", async () => {
    const res = await request(app)
      .get("/api/commissions/summary?period=2025-13")
      .set(withAuth(admin.id));
    expect(res.status).toBe(400);
  });

  it("403s for a role without commission:read", async () => {
    const res = await request(app)
      .get("/api/commissions/summary")
      .set(withAuth(viewer.id));
    expect(res.status).toBe(403);
  });
});
