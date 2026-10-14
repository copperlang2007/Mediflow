/**
 * Quoting plan lookup over the public CMS plan tables (migration 0071):
 * contact:read gate, county search, employer-group hiding, global (cross-org) data.
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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let handle: TestDbHandle;
let admin: { id: string };
let otherAdmin: { id: string };
let agentUser: { id: string };

const pkgRow = (bidId: string, planName: string, extra: Record<string, unknown> = {}) => ({
  planYear: 2027,
  bidId,
  contractId: bidId.slice(0, 5),
  planId: "001",
  segmentId: "0",
  planTypeLabel: "HMO",
  orgName: "Acme Health",
  orgMarketingName: "Acme",
  planName,
  ...extra,
});

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  const { cmsPlanBenefitPackagesTable, cmsPlanBenefitSectionsTable, cmsPlanServiceAreasTable } =
    await import("@workspace/db");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;

  const org = await seedOrg(handle.db, { id: "qp-org" });
  const otherOrg = await seedOrg(handle.db, { id: "qp-other-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  otherAdmin = await seedUser(handle.db, { orgId: otherOrg.id, role: "agency_admin" });
  agentUser = await seedUser(handle.db, { orgId: org.id, role: "agent" });

  await handle.db.insert(cmsPlanBenefitPackagesTable).values([
    pkgRow("H1111_001_0", "Alpha Saver (HMO)"),
    pkgRow("H2222_001_0", "Beta 100% Plus", { orgName: "Zed Co", orgMarketingName: "Zed", isSnp: true, snpType: "Dual-Eligible" }),
    pkgRow("H3333_800_0", "Employer Only", { isEmployerGroup: true }),
    pkgRow("H4444_001_0", "Old Year", { planYear: 2026 }),
  ] as never);
  await handle.db.insert(cmsPlanServiceAreasTable).values([
    { planYear: 2027, bidId: "H1111_001_0", countyCode: "45910", stateCode: "TX", countyName: "Tarrant", partialFlag: "1" },
    { planYear: 2027, bidId: "H2222_001_0", countyCode: "10010", stateCode: "FL", countyName: "Alachua" },
    { planYear: 2027, bidId: "H3333_800_0", countyCode: "45910", stateCode: "TX", countyName: "Tarrant" },
    { planYear: 2027, bidId: "H3333_800_0", countyCode: "99999", stateCode: "AK", countyName: "Hidden" },
    // Same county code, different name casing on two plans: must list once.
    { planYear: 2027, bidId: "H1111_001_0", countyCode: "45920", stateCode: "TX", countyName: "Dallas" },
    { planYear: 2027, bidId: "H2222_001_0", countyCode: "45920", stateCode: "TX", countyName: "DALLAS" },
  ]);
  await handle.db.insert(cmsPlanBenefitSectionsTable).values([
    { planYear: 2027, bidId: "H1111_001_0", section: "b16_dental", rowSeq: 1, data: { a: "2" } },
    { planYear: 2027, bidId: "H1111_001_0", section: "b16_dental", rowSeq: 0, data: { a: "1" } },
    { planYear: 2027, bidId: "H1111_001_0", section: "b1_inpat", rowSeq: 0, data: { b: "1" } },
  ]);
});

afterAll(async () => {
  await shutdownTestDb();
});

const get = (url: string, id = admin.id) => request(app).get(url).set(withAuth(id));

describe("quoting plans", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await request(app).get("/api/quoting/plan-areas/states")).status).toBe(401);
  });

  it("requires contact:read (agent -> 403)", async () => {
    expect((await get("/api/quoting/plan-areas/states", agentUser.id)).status).toBe(403);
  });

  it("lists states without employer-only states", async () => {
    const res = await get("/api/quoting/plan-areas/states");
    expect(res.status).toBe(200);
    expect(res.body.planYear).toBe(2027);
    expect(res.body.data).toEqual([{ stateCode: "FL" }, { stateCode: "TX" }]);
  });

  it("lists counties for a state", async () => {
    const res = await get("/api/quoting/plan-areas/counties?state=tx");
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { countyCode: string }) => c.countyCode)).toEqual(["45920", "45910"]);
    expect(res.body.data[1].countyName).toBe("Tarrant");
    expect(res.body.data[0].countyName.toLowerCase()).toBe("dallas");
    expect((await get("/api/quoting/plan-areas/counties?state=T")).status).toBe(400);
  });

  it("returns only that county's non-employer plans", async () => {
    const res = await get("/api/quoting/plans?state=TX&countyCode=45910");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.truncated).toBe(false);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ bidId: "H1111_001_0", partial: true, isSnp: false });
  });

  it("filters by text (wildcards escaped) and SNP", async () => {
    const hit = await get("/api/quoting/plans?state=FL&countyCode=10010&q=beta");
    expect(hit.body.data.map((p: { bidId: string }) => p.bidId)).toEqual(["H2222_001_0"]);
    const wild = await get("/api/quoting/plans?state=FL&countyCode=10010&q=_");
    expect(wild.body.data).toHaveLength(0);
    const literal = await get("/api/quoting/plans?state=FL&countyCode=10010&q=100%25");
    expect(literal.body.data).toHaveLength(1);
    const excl = await get("/api/quoting/plans?state=FL&countyCode=10010&snp=exclude");
    expect(excl.body.data).toHaveLength(0);
    const only = await get("/api/quoting/plans?state=FL&countyCode=10010&snp=only");
    expect(only.body.data).toHaveLength(1);
  });

  it("rejects a bad county code", async () => {
    expect((await get("/api/quoting/plans?state=TX&countyCode=459")).status).toBe(400);
    expect((await get("/api/quoting/plans?state=TX")).status).toBe(400);
  });

  it("returns plan detail with sections ordered", async () => {
    const res = await get("/api/quoting/plans/H1111_001_0");
    expect(res.status).toBe(200);
    expect(res.body.plan.planName).toBe("Alpha Saver (HMO)");
    expect(res.body.sections).toEqual([
      { section: "b16_dental", rows: [{ a: "1" }, { a: "2" }] },
      { section: "b1_inpat", rows: [{ b: "1" }] },
    ]);
  });

  it("404s for employer group and unknown ids", async () => {
    expect((await get("/api/quoting/plans/H3333_800_0")).status).toBe(404);
    expect((await get("/api/quoting/plans/H9999_999_9")).status).toBe(404);
    expect((await get("/api/quoting/plans/bad-id")).status).toBe(400);
  });

  it("does not log search text when the database fails", async () => {
    const { logger } = await import("../../lib/logger");
    const warn = vi.spyOn(logger, "warn");
    const realSelect = handle.db.select.bind(handle.db);
    // Fail only the route's plan-year lookup (auth uses other selects).
    const sel = vi.spyOn(handle.db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      if (fields && "y" in fields) throw new Error("failed query: ilike $1 params: %secretterm%");
      return realSelect(fields as never);
    }) as never);
    const res = await get("/api/quoting/plans?state=TX&countyCode=45910&q=secretterm");
    sel.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Plan data could not be loaded right now.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secretterm");
    warn.mockRestore();
  });

  it("returns identical data to admins of different orgs", async () => {
    const url = "/api/quoting/plans?state=TX&countyCode=45910";
    const a = await get(url, admin.id);
    const b = await get(url, otherAdmin.id);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });
});
