/**
 * Integration tests for the agent "Ready to Sell" readiness board
 * (routes/agentReadiness.ts + lib/agents/readiness.ts).
 *
 * The admin-facing inverse of the inbound router: for every agent in the org,
 * compute readyToSell + the blockers preventing it. Verifies the per-agent
 * verdict across the gate combinations (fully ready, missing AHIP, no active
 * license, inactive, license+AHIP-but-no-carrier-cert), the not-ready-first
 * ordering, the certificationYear filter, and the permission gate (an `agent`
 * role lacks `agent:read` → 403).
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
  carriersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  agentsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { AgentReadiness } from "../../lib/agents/readiness";

import type { Express } from "express";
import { sellingPlanYear } from "../../lib/compliance/planYear";

const YEAR = 2026;
const OTHER_YEAR = 2025;
const FUTURE = new Date("2027-01-01T00:00:00Z");

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let agentRoleUser: { id: string };
let carrierA: { id: string };

// Agents seeded once, asserted by id across the suite.
let ready: { id: string };
let noAhip: { id: string };
let noLicense: { id: string };
let inactive: { id: string };
let noCarrier: { id: string };

// Helpers ------------------------------------------------------------------

async function giveLicense(
  agentId: string,
  stateCode: string,
  opts: { status?: string; expiryDate?: Date | null } = {},
): Promise<void> {
  await testDb.insert(stateLicensesTable).values({
    id: `lic-${randomUUID()}`,
    agentId,
    stateCode,
    licenseType: "health",
    status: (opts.status ?? "active") as "active",
    expiryDate: opts.expiryDate === undefined ? FUTURE : opts.expiryDate,
  });
}

async function giveCarrierCert(
  agentId: string,
  carrierId: string,
  opts: { status?: string; year?: number; expiryDate?: Date | null } = {},
): Promise<void> {
  await testDb.insert(carrierCertificationsTable).values({
    id: `cert-${randomUUID()}`,
    agentId,
    carrierId,
    certificationYear: opts.year ?? YEAR,
    status: (opts.status ?? "passed") as "passed",
    expiryDate: opts.expiryDate === undefined ? FUTURE : opts.expiryDate,
  });
}

async function giveAhip(
  agentId: string,
  opts: { status?: string; year?: number } = {},
): Promise<void> {
  await testDb.insert(ahipRecordsTable).values({
    id: `ahip-${randomUUID()}`,
    agentId,
    certificationYear: opts.year ?? YEAR,
    status: (opts.status ?? "passed") as "passed",
  });
}

async function activate(agentId: string): Promise<void> {
  await testDb
    .update(agentsTable)
    .set({ status: "active" })
    .where(eq(agentsTable.id, agentId));
}

function readiness(params: Record<string, string> = {}, userId?: string) {
  const qs = new URLSearchParams(params).toString();
  return request(app)
    .get(`/api/agents/readiness${qs ? `?${qs}` : ""}`)
    .set(withAuth(userId ?? admin.id));
}

function findAgent(
  body: { data: AgentReadiness[] },
  id: string,
): AgentReadiness | undefined {
  return body.data.find((a) => a.agentId === id);
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "rts-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  agentRoleUser = await seedUser(testDb, { orgId: org.id, role: "agent" });

  carrierA = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values([{ id: carrierA.id, orgId: org.id, name: "Acme Health" }]);

  // 1) Fully ready — active, AHIP, FL license, carrier cert.
  ready = await seedAgent(testDb, { orgId: org.id, lastName: "Able" });
  await activate(ready.id);
  await giveLicense(ready.id, "FL");
  await giveCarrierCert(ready.id, carrierA.id);
  await giveAhip(ready.id);

  // 2) Missing AHIP — everything else present.
  noAhip = await seedAgent(testDb, { orgId: org.id, lastName: "Brown" });
  await activate(noAhip.id);
  await giveLicense(noAhip.id, "FL");
  await giveCarrierCert(noAhip.id, carrierA.id);

  // 3) No active license — suspended license only.
  noLicense = await seedAgent(testDb, { orgId: org.id, lastName: "Clark" });
  await activate(noLicense.id);
  await giveLicense(noLicense.id, "FL", { status: "suspended" });
  await giveCarrierCert(noLicense.id, carrierA.id);
  await giveAhip(noLicense.id);

  // 4) Inactive agent — full credentials but never activated (onboarding).
  inactive = await seedAgent(testDb, { orgId: org.id, lastName: "Davis" });
  await giveLicense(inactive.id, "FL");
  await giveCarrierCert(inactive.id, carrierA.id);
  await giveAhip(inactive.id);

  // 5) License + AHIP but NO carrier cert.
  noCarrier = await seedAgent(testDb, { orgId: org.id, lastName: "Evans" });
  await activate(noCarrier.id);
  await giveLicense(noCarrier.id, "FL");
  await giveAhip(noCarrier.id);
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /agents/readiness — per-agent verdict + blockers", () => {
  it("marks a fully credentialed active agent ready with no blockers", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    expect(res.status).toBe(200);
    const a = findAgent(res.body, ready.id)!;
    expect(a.readyToSell).toBe(true);
    expect(a.active).toBe(true);
    expect(a.ahipCurrent).toBe(true);
    expect(a.licensedStates).toContain("FL");
    expect(a.certifiedCarriers.map((c: { carrierId: string }) => c.carrierId)).toContain(
      carrierA.id,
    );
    expect(a.certifiedCarriers[0].name).toBe("Acme Health");
    expect(a.blockers).toEqual([]);
  });

  it("blocks an agent missing AHIP", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    const a = findAgent(res.body, noAhip.id)!;
    expect(a.readyToSell).toBe(false);
    expect(a.ahipCurrent).toBe(false);
    expect(a.blockers).toContain("AHIP not current");
    // Other gates pass, so AHIP is the only blocker.
    expect(a.blockers).toEqual(["AHIP not current"]);
  });

  it("blocks an agent with no active state license", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    const a = findAgent(res.body, noLicense.id)!;
    expect(a.readyToSell).toBe(false);
    expect(a.licensedStates).toEqual([]);
    expect(a.blockers).toContain("No active state license");
  });

  it("blocks an inactive agent even with full credentials", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    const a = findAgent(res.body, inactive.id)!;
    expect(a.readyToSell).toBe(false);
    expect(a.active).toBe(false);
    expect(a.blockers).toContain("Inactive");
  });

  it("blocks an agent with license + AHIP but no carrier cert", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    const a = findAgent(res.body, noCarrier.id)!;
    expect(a.readyToSell).toBe(false);
    expect(a.certifiedCarriers).toEqual([]);
    expect(a.blockers).toEqual(["No carrier certifications"]);
  });

  it("reports the org summary counts", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    expect(res.body.totalCount).toBe(5);
    expect(res.body.readyCount).toBe(1);
    expect(res.body.certificationYear).toBe(YEAR);
    expect(typeof res.body.asOf).toBe("string");
  });
});

describe("GET /agents/readiness — ordering", () => {
  it("sorts not-ready agents first, then by lastName", async () => {
    const res = await readiness({ certificationYear: String(YEAR) });
    const ids: string[] = res.body.data.map((a: { agentId: string }) => a.agentId);
    // The only ready agent (Able) must come LAST despite sorting first
    // alphabetically — not-ready-first dominates.
    expect(ids[ids.length - 1]).toBe(ready.id);
    // Not-ready block is lastName-sorted: Brown, Clark, Davis, Evans.
    const notReady = res.body.data
      .filter((a: { readyToSell: boolean }) => !a.readyToSell)
      .map((a: { lastName: string }) => a.lastName);
    expect(notReady).toEqual(["Brown", "Clark", "Davis", "Evans"]);
  });
});

describe("GET /agents/readiness — certificationYear filter", () => {
  it("evaluates AHIP/cert gates against the requested year", async () => {
    // For OTHER_YEAR none of the agents have AHIP/cert rows, so the otherwise
    // ready agent is no longer ready (AHIP + carrier blockers appear).
    const res = await readiness({ certificationYear: String(OTHER_YEAR) });
    expect(res.body.certificationYear).toBe(OTHER_YEAR);
    const a = findAgent(res.body, ready.id)!;
    expect(a.readyToSell).toBe(false);
    expect(a.ahipCurrent).toBe(false);
    expect(a.certifiedCarriers).toEqual([]);
    expect(a.blockers).toContain("AHIP not current");
    expect(a.blockers).toContain("No carrier certifications");
    // License is not year-scoped, so it still shows.
    expect(a.licensedStates).toContain("FL");
    expect(res.body.readyCount).toBe(0);
  });

  it("defaults certificationYear to the plan year being sold when omitted", async () => {
    const res = await readiness();
    expect(res.status).toBe(200);
    expect(res.body.certificationYear).toBe(sellingPlanYear());
  });
});

describe("GET /agents/readiness — permission gate", () => {
  it("403s for an `agent` role (lacks agent:read)", async () => {
    const res = await readiness({}, agentRoleUser.id);
    expect(res.status).toBe(403);
  });

  it("200s for an allowed role (agency_admin)", async () => {
    const res = await readiness();
    expect(res.status).toBe(200);
  });
});
