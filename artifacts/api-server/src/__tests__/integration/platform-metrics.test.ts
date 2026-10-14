/**
 * Platform metrics — super_admin revenue, commission and growth rollup.
 *
 * Pins: super_admin only; revenue counts ACTIVE paid subscriptions at list
 * price (trialing and canceled do not count, past_due is "at risk"); the
 * commission totals and monthly series sum carrier line items across every
 * agency; the growth series is a gap-free 12-month window.
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
  commissionLineItemsTable,
  commissionStatementsTable,
  contactsTable,
  subscriptionsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedContact, seedOrg, seedUser, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let growthOrg: { id: string };
let trialOrg: { id: string };
let lateOrg: { id: string };
let canceledOrg: { id: string };
let freshOrg: { id: string };
let lastTwelveMonths: () => string[];
let superAdmin: { id: string };
let agencyAdmin: { id: string };

async function subscribe(
  orgId: string,
  planTier: "starter" | "growth" | "agency",
  status: string,
) {
  await testDb.insert(subscriptionsTable).values({
    id: `sub-${randomUUID()}`,
    orgId,
    planTier,
    status: status as never,
  });
}

async function commission(
  orgId: string,
  amount: string,
  periodStart: string,
  // null = the carrier row had no period columns; the statement's period applies.
  linePeriodStart: string | null = periodStart,
) {
  const [carrierId, statementId] = [
    `carrier-${randomUUID()}`,
    `stmt-${randomUUID()}`,
  ];
  await testDb
    .insert(carriersTable)
    .values({ id: carrierId, orgId, name: "Aetna", isActive: true });
  await testDb.insert(commissionStatementsTable).values({
    id: statementId,
    orgId,
    carrierId,
    statementDate: periodStart,
    periodStart,
    periodEnd: periodStart,
    totalAmount: amount,
    currency: "USD",
    source: "csv_upload",
    storageKey: `k/${statementId}`,
    status: "reconciled",
    uploadedByUserId: null,
  });
  await testDb.insert(commissionLineItemsTable).values({
    id: `li-${randomUUID()}`,
    statementId,
    orgId,
    contactId: null,
    memberId: null,
    policyNumber: "POL-1",
    planType: "MAPD",
    planYear: 2026,
    periodStart: linePeriodStart,
    periodEnd: linePeriodStart,
    premium: "120.00",
    commissionAmount: amount,
    type: "initial",
    writingAgentId: null,
    matchStatus: "matched",
    raw: {},
    payoutContribution: null as never,
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  ({ lastTwelveMonths } = await import("../../routes/workspaces"));
  request = (await import("supertest")).default;

  const stamp = Date.now();
  growthOrg = await seedOrg(testDb, {
    name: "Growth Agency",
    slug: `growth-${stamp}`,
  });
  trialOrg = await seedOrg(testDb, {
    name: "Trial Agency",
    slug: `trial-${stamp}`,
  });
  lateOrg = await seedOrg(testDb, {
    name: "Late Agency",
    slug: `late-${stamp}`,
  });
  canceledOrg = await seedOrg(testDb, {
    name: "Canceled Agency",
    slug: `canceled-${stamp}`,
  });
  // Just created: no subscription row and no commission lines yet.
  freshOrg = await seedOrg(testDb, {
    name: "Fresh Agency",
    slug: `fresh-${stamp}`,
  });
  superAdmin = await seedUser(testDb, {
    orgId: growthOrg.id,
    role: "super_admin",
  });
  agencyAdmin = await seedUser(testDb, {
    orgId: growthOrg.id,
    role: "agency_admin",
    email: "ag@example.test",
  });
  await seedContact(testDb, { orgId: growthOrg.id });
  await seedContact(testDb, { orgId: growthOrg.id });

  await subscribe(growthOrg.id, "growth", "active"); // $297
  await subscribe(trialOrg.id, "agency", "trialing"); // not revenue yet
  await subscribe(lateOrg.id, "agency", "past_due"); // $997 at risk
  await subscribe(canceledOrg.id, "growth", "canceled"); // no revenue

  const months = lastTwelveMonths();
  await commission(growthOrg.id, "100.50", `${months[11]}-10`); // this month
  await commission(growthOrg.id, "200.00", `${months[10]}-10`); // last month
  await commission(lateOrg.id, "50.25", `${months[11]}-12`);
  await commission(lateOrg.id, "999.00", "2019-01-15"); // far outside the 12-month window
  await commission(growthOrg.id, "7777.00", "2099-01-15"); // future period: counted nowhere
  // No period on the line itself: the statement's period (two months ago) applies, not "now".
  await commission(growthOrg.id, "40.00", `${months[9]}-05`, null);

  // A client added three months ago and deleted since: history keeps them.
  const old = await seedContact(testDb, { orgId: growthOrg.id });
  const threeMonthsAgo = new Date(
    Date.UTC(Number(months[8].slice(0, 4)), Number(months[8].slice(5)) - 1, 15),
  );
  await testDb
    .update(contactsTable)
    .set({ createdAt: threeMonthsAgo, deletedAt: new Date() })
    .where(eq(contactsTable.id, old.id));
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/admin/platform/metrics", () => {
  it("is super_admin only", async () => {
    expect(
      (
        await request(app)
          .get("/api/admin/platform/metrics")
          .set(withAuth(agencyAdmin.id))
      ).status,
    ).toBe(403);
    expect((await request(app).get("/api/admin/platform/metrics")).status).toBe(
      401,
    );
  });

  it("counts only active paid subscriptions at list price", async () => {
    const res = await request(app)
      .get("/api/admin/platform/metrics")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    const { revenue } = res.body;
    expect(revenue.basis).toBe("list_price");
    expect(revenue.mrrCents).toBe(29_700);
    expect(revenue.arrCents).toBe(29_700 * 12);
    expect(revenue.payingAgencies).toBe(1);
    expect(revenue.trialingAgencies).toBe(1);
    expect(revenue.pastDueAgencies).toBe(1);
    expect(revenue.atRiskCents).toBe(99_700);
    expect(revenue.byPlan).toEqual([
      { tier: "growth", agencies: 1, mrrCents: 29_700 },
    ]);
  });

  it("sums commissions across agencies, separating the last 12 months", async () => {
    const res = await request(app)
      .get("/api/admin/platform/metrics")
      .set(withAuth(superAdmin.id));
    expect(res.body.commissions.last12MonthsCents).toBe(
      10_050 + 20_000 + 5_025 + 4_000,
    );
    expect(res.body.commissions.allTimeCents).toBe(
      10_050 + 20_000 + 5_025 + 4_000 + 99_900,
    );
    const growth = res.body.agencies.find(
      (a: { orgId: string }) => a.orgId === growthOrg.id,
    );
    expect(growth.commissionsLast12MonthsCents).toBe(34_050);
    // The 2099-dated line item is excluded from every total, not just the chart.
    expect(growth.commissionsAllTimeCents).toBe(34_050);
    expect(growth.mrrCents).toBe(29_700);
    expect(growth.subscriptionStatus).toBe("active");
    const late = res.body.agencies.find(
      (a: { orgId: string }) => a.orgId === lateOrg.id,
    );
    expect(late.commissionsAllTimeCents).toBe(5_025 + 99_900);
    expect(late.mrrCents).toBe(0);
    expect(late.subscriptionStatus).toBe("past_due");
  });

  it("returns a gap-free 12-month growth series with running totals", async () => {
    const res = await request(app)
      .get("/api/admin/platform/metrics")
      .set(withAuth(superAdmin.id));
    const months = lastTwelveMonths();
    expect(res.body.months).toEqual(months);
    expect(res.body.growth.map((g: { month: string }) => g.month)).toEqual(
      months,
    );
    const last = res.body.growth[11];
    expect(last.newAgencies).toBe(5); // all five seeded just now
    expect(last.totalAgencies).toBe(5);
    expect(last.newClients).toBe(2);
    expect(last.totalClients).toBe(2);
    expect(last.commissionsCents).toBe(10_050 + 5_025);
    expect(res.body.growth[10].commissionsCents).toBe(20_000);
    expect(res.body.growth[0].totalAgencies).toBe(0);
  });

  it("lists an agency with no subscription or commissions as none, with zero amounts", async () => {
    const res = await request(app)
      .get("/api/admin/platform/metrics")
      .set(withAuth(superAdmin.id));
    const fresh = res.body.agencies.find(
      (a: { orgId: string }) => a.orgId === freshOrg.id,
    );
    expect(fresh).toEqual({
      orgId: freshOrg.id,
      subscriptionStatus: "none",
      planTier: null,
      mrrCents: 0,
      commissionsLast12MonthsCents: 0,
      commissionsAllTimeCents: 0,
    });
    expect(res.body.agencies).toHaveLength(5);
  });

  it("uses the statement's period when a line item has none", async () => {
    const res = await request(app)
      .get("/api/admin/platform/metrics")
      .set(withAuth(superAdmin.id));
    const months = lastTwelveMonths();
    expect(res.body.growth[9].month).toBe(months[9]);
    expect(res.body.growth[9].commissionsCents).toBe(4_000);
    // Not misfiled under the month the row was uploaded.
    expect(res.body.growth[11].commissionsCents).toBe(10_050 + 5_025);
  });

  it("keeps a since-deleted client in the months it existed", async () => {
    const res = await request(app)
      .get("/api/admin/platform/metrics")
      .set(withAuth(superAdmin.id));
    const g = res.body.growth;
    expect(g[8].newClients).toBe(1); // added then, though deleted since
    expect(g[8].totalClients).toBe(1);
    expect(g[10].totalClients).toBe(1);
    expect(g[11].totalClients).toBe(2); // the two live clients; the deleted one is gone only from now on
    expect(g[11].newClients).toBe(2);
  });
});
