/**
 * Chargeback / clawback exposure report (routes/clawbacks.ts):
 *
 *   GET /api/clawbacks/summary[?days=]  — exposure totals + per-agent breakdown
 *   GET /api/clawbacks[?days=]          — the chargeback line items
 *
 * Read-only over `commission_line_items` (type = 'chargeback'). Gated on
 * `commission:read` — a plain `agent` role gets 403.
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
import {
  carriersTable,
  commissionStatementsTable,
  commissionLineItemsTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let agentA: { id: string };
let agentB: { id: string };
let statementId: string;

async function lineItem(opts: {
  amount: string;
  type: "initial" | "renewal" | "bonus" | "chargeback";
  agentId: string | null;
  periodStart: string;
}): Promise<void> {
  const id = `li-${randomUUID()}`;
  await testDb.insert(commissionLineItemsTable).values({
    id,
    statementId,
    orgId: org.id,
    policyNumber: `POL-${id.slice(-6)}`,
    planType: "MAPD",
    planYear: 2026,
    periodStart: opts.periodStart,
    periodEnd: opts.periodStart,
    premium: "120.00",
    commissionAmount: opts.amount,
    type: opts.type,
    writingAgentId: opts.agentId,
    matchStatus: "unmatched",
    raw: {},
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "claw-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  agentA = await seedAgent(testDb, { orgId: org.id, firstName: "Dana", lastName: "Cole" });
  agentB = await seedAgent(testDb, { orgId: org.id, firstName: "Sam", lastName: "Lee" });

  const carrierId = `carrier-${randomUUID()}`;
  await testDb.insert(carriersTable).values({ id: carrierId, orgId: org.id, name: "Acme Health" });
  statementId = `stmt-${randomUUID()}`;
  await testDb.insert(commissionStatementsTable).values({
    id: statementId,
    orgId: org.id,
    carrierId,
    statementDate: "2026-03-01",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    totalAmount: "1000.00",
    currency: "USD",
    source: "csv_upload",
    status: "parsed",
  });

  // In-window gross commission.
  await lineItem({ amount: "500.00", type: "initial", agentId: agentA.id, periodStart: "2026-01-01" });
  await lineItem({ amount: "300.00", type: "initial", agentId: agentB.id, periodStart: "2026-01-01" });
  // In-window chargebacks (stored negative).
  await lineItem({ amount: "-200.00", type: "chargeback", agentId: agentA.id, periodStart: "2026-02-01" });
  await lineItem({ amount: "-50.00", type: "chargeback", agentId: agentA.id, periodStart: "2026-03-01" });
  await lineItem({ amount: "-100.00", type: "chargeback", agentId: agentB.id, periodStart: "2026-02-01" });
  // Out-of-window chargeback (must be excluded from the 365-day view).
  await lineItem({ amount: "-999.00", type: "chargeback", agentId: agentA.id, periodStart: "2023-01-01" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /clawbacks/summary", () => {
  it("totals clawbacks in the window, computes the rate, and ranks agents", async () => {
    const res = await request(app)
      .get("/api/clawbacks/summary?days=365")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const b = res.body;

    // 3 in-window chargebacks (the 2023 one is excluded).
    expect(b.chargebackCount).toBe(3);
    expect(b.clawbackTotal).toBe(350); // 200 + 50 + 100
    expect(b.grossCommission).toBe(800); // 500 + 300
    expect(b.clawbackRate).toBeCloseTo(350 / 800, 5);

    // Agent A carries more exposure (250) than B (100); A sorts first.
    expect(b.byAgent[0].agentName).toBe("Dana Cole");
    expect(b.byAgent[0].total).toBe(250);
    expect(b.byAgent[0].count).toBe(2);
    const samExposure = b.byAgent.find((a: { agentName: string }) => a.agentName === "Sam Lee");
    expect(samExposure.total).toBe(100);
  });

  it("excludes out-of-window chargebacks via a narrow days filter", async () => {
    // 45 days back from 'today' (2026-06-09) excludes everything (latest is 2026-03).
    const res = await request(app)
      .get("/api/clawbacks/summary?days=45")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.chargebackCount).toBe(0);
    expect(res.body.clawbackTotal).toBe(0);
    expect(res.body.clawbackRate).toBe(0);
  });
});

describe("GET /clawbacks", () => {
  it("lists the in-window chargeback line items with agent names, newest first", async () => {
    const res = await request(app).get("/api/clawbacks?days=365").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
    for (const r of res.body) expect(r.item.type).toBe("chargeback");
    // Newest period first.
    expect(res.body[0].item.periodStart >= res.body[1].item.periodStart).toBe(true);
  });
});

describe("clawbacks — RBAC", () => {
  it("403s a role without commission read (agent)", async () => {
    const agent = await seedUser(testDb, { orgId: org.id, role: "agent" });
    const res = await request(app).get("/api/clawbacks/summary").set(withAuth(agent.id));
    expect(res.status).toBe(403);
  });
});
