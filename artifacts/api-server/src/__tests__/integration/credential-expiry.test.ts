/**
 * Integration tests for the "Credentials expiring soon" early-warning view
 * (routes/agentReadiness.ts → GET /agents/credential-expiry +
 * lib/agents/credentialExpiry.ts).
 *
 * The forward-looking complement to the readiness board: for an org's ACTIVE
 * agents, which licenses / carrier certs are about to expire (future, but
 * within `withinDays`), each with an urgency tier (critical ≤7, soon ≤30,
 * upcoming ≤60). Verifies tiering, daysUntil, soonest-first ordering, the
 * window filter (out-of-window + already-expired excluded), the inactive-agent
 * and non-`active`-status-credential exclusions, the summary counts, and the
 * `agent:read` permission gate.
 *
 * `now` is pinned via a fixed server clock by anchoring every seeded expiry to
 * `new Date()` at boot, then asserting tiers/daysUntil with a tolerance window
 * (the handler uses its own `new Date()`), so the suite is robust to the few-ms
 * gap between seed time and request time.
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
  agentsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { ExpiringCredential } from "../../lib/agents/credentialExpiry";

import type { Express } from "express";

const YEAR = new Date().getUTCFullYear();
const DAY = 24 * 60 * 60 * 1000;
/** Anchor for every seeded expiry — the handler's own clock will be ~now. */
const BASE = Date.now();
const inDays = (n: number): Date => new Date(BASE + n * DAY);

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let agentRoleUser: { id: string };
let carrierA: { id: string };

// Agents seeded once, asserted by id across the suite.
let critical: { id: string }; // license expiring in 5 days
let soon: { id: string }; // carrier cert expiring in 20 days
let upcoming: { id: string }; // license expiring in 50 days
let farOut: { id: string }; // license expiring in 200 days (out of 60d window)
let lapsed: { id: string }; // license already expired (excluded)
let inactiveAgent: { id: string }; // active creds but inactive agent (excluded)

// Helpers ------------------------------------------------------------------

async function giveLicense(
  agentId: string,
  stateCode: string,
  expiryDate: Date,
  opts: { status?: string } = {},
): Promise<void> {
  await testDb.insert(stateLicensesTable).values({
    id: `lic-${randomUUID()}`,
    agentId,
    stateCode,
    licenseType: "health",
    status: (opts.status ?? "active") as "active",
    expiryDate,
  });
}

async function giveCarrierCert(
  agentId: string,
  carrierId: string,
  expiryDate: Date,
  opts: { status?: string } = {},
): Promise<void> {
  await testDb.insert(carrierCertificationsTable).values({
    id: `cert-${randomUUID()}`,
    agentId,
    carrierId,
    certificationYear: YEAR,
    status: (opts.status ?? "passed") as "passed",
    expiryDate,
  });
}

async function activate(agentId: string): Promise<void> {
  await testDb
    .update(agentsTable)
    .set({ status: "active" })
    .where(eq(agentsTable.id, agentId));
}

function expiry(params: Record<string, string> = {}, userId?: string) {
  const qs = new URLSearchParams(params).toString();
  return request(app)
    .get(`/api/agents/credential-expiry${qs ? `?${qs}` : ""}`)
    .set(withAuth(userId ?? admin.id));
}

function byAgent(
  body: { data: ExpiringCredential[] },
  id: string,
): ExpiringCredential[] {
  return body.data.filter((c) => c.agentId === id);
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "cred-expiry-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  agentRoleUser = await seedUser(testDb, { orgId: org.id, role: "agent" });

  carrierA = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values([{ id: carrierA.id, orgId: org.id, name: "Acme Health" }]);

  // 1) Critical — active license expiring in 5 days.
  critical = await seedAgent(testDb, { orgId: org.id, lastName: "Able" });
  await activate(critical.id);
  await giveLicense(critical.id, "FL", inDays(5));

  // 2) Soon — active carrier cert expiring in 20 days.
  soon = await seedAgent(testDb, { orgId: org.id, lastName: "Brown" });
  await activate(soon.id);
  await giveCarrierCert(soon.id, carrierA.id, inDays(20));

  // 3) Upcoming — active license expiring in 50 days.
  upcoming = await seedAgent(testDb, { orgId: org.id, lastName: "Clark" });
  await activate(upcoming.id);
  await giveLicense(upcoming.id, "GA", inDays(50));

  // 4) Far out — license expiring in 200 days (excluded at withinDays=60).
  farOut = await seedAgent(testDb, { orgId: org.id, lastName: "Davis" });
  await activate(farOut.id);
  await giveLicense(farOut.id, "TX", inDays(200));

  // 5) Already lapsed — license expired 10 days ago (excluded: not upcoming).
  lapsed = await seedAgent(testDb, { orgId: org.id, lastName: "Evans" });
  await activate(lapsed.id);
  await giveLicense(lapsed.id, "NY", inDays(-10));

  // 6) Inactive agent — license expiring in 5 days but agent never activated.
  inactiveAgent = await seedAgent(testDb, { orgId: org.id, lastName: "Frost" });
  await giveLicense(inactiveAgent.id, "OH", inDays(5));
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /agents/credential-expiry — window + tiers", () => {
  it("returns active agents' creds expiring within the window, soonest-first", async () => {
    const res = await expiry({ withinDays: "60" });
    expect(res.status).toBe(200);
    expect(res.body.withinDays).toBe(60);
    expect(typeof res.body.asOf).toBe("string");

    const ids = res.body.data.map((c: ExpiringCredential) => c.agentId);
    // Critical (5d), Soon (20d), Upcoming (50d) — in that order.
    expect(ids).toEqual([critical.id, soon.id, upcoming.id]);
  });

  it("tiers the 5-day license as critical with correct daysUntil + type", async () => {
    const res = await expiry({ withinDays: "60" });
    const [c] = byAgent(res.body, critical.id);
    expect(c.type).toBe("license");
    expect(c.label).toBe("FL");
    expect(c.tier).toBe("critical");
    expect(c.daysUntil).toBeGreaterThanOrEqual(4);
    expect(c.daysUntil).toBeLessThanOrEqual(5);
  });

  it("tiers the 20-day carrier cert as soon with the carrier name label", async () => {
    const res = await expiry({ withinDays: "60" });
    const [c] = byAgent(res.body, soon.id);
    expect(c.type).toBe("carrier_cert");
    expect(c.label).toBe("Acme Health");
    expect(c.tier).toBe("soon");
    expect(c.daysUntil).toBeGreaterThanOrEqual(19);
    expect(c.daysUntil).toBeLessThanOrEqual(20);
  });

  it("tiers the 50-day license as upcoming", async () => {
    const res = await expiry({ withinDays: "60" });
    const [c] = byAgent(res.body, upcoming.id);
    expect(c.tier).toBe("upcoming");
    expect(c.daysUntil).toBeGreaterThanOrEqual(49);
    expect(c.daysUntil).toBeLessThanOrEqual(50);
  });

  it("reports tier counts", async () => {
    const res = await expiry({ withinDays: "60" });
    expect(res.body.counts).toEqual({ critical: 1, soon: 1, upcoming: 1 });
  });
});

describe("GET /agents/credential-expiry — exclusions", () => {
  it("excludes a credential expiring beyond the window", async () => {
    const res = await expiry({ withinDays: "60" });
    expect(byAgent(res.body, farOut.id)).toEqual([]);
  });

  it("excludes an already-expired (lapsed) credential", async () => {
    const res = await expiry({ withinDays: "60" });
    expect(byAgent(res.body, lapsed.id)).toEqual([]);
  });

  it("excludes credentials of an inactive agent", async () => {
    const res = await expiry({ withinDays: "60" });
    expect(byAgent(res.body, inactiveAgent.id)).toEqual([]);
  });

  it("widening the window to 90d pulls in nothing new here but keeps the 50d one", async () => {
    const res = await expiry({ withinDays: "90" });
    const ids = res.body.data.map((c: ExpiringCredential) => c.agentId);
    expect(ids).toContain(upcoming.id);
    // 200-day far-out is still excluded at 90d.
    expect(ids).not.toContain(farOut.id);
  });

  it("narrowing the window to 7d keeps only the critical credential", async () => {
    const res = await expiry({ withinDays: "7" });
    const ids = res.body.data.map((c: ExpiringCredential) => c.agentId);
    expect(ids).toEqual([critical.id]);
    expect(res.body.counts).toEqual({ critical: 1, soon: 0, upcoming: 0 });
  });

  it("excludes a non-active-status credential of an active agent", async () => {
    // Give the upcoming agent a SUSPENDED license expiring in 5 days — it must
    // not surface even though it is in-window, because suspended creds don't
    // count toward eligibility.
    await giveLicense(upcoming.id, "AL", inDays(5), { status: "suspended" });
    const res = await expiry({ withinDays: "60" });
    const labels = byAgent(res.body, upcoming.id).map((c) => c.label);
    expect(labels).not.toContain("AL");
    // Their valid 50-day GA license is still present.
    expect(labels).toContain("GA");
  });
});

describe("GET /agents/credential-expiry — validation + default", () => {
  it("defaults withinDays to 60 when omitted", async () => {
    const res = await expiry();
    expect(res.status).toBe(200);
    expect(res.body.withinDays).toBe(60);
  });

  it("400s on an out-of-range withinDays", async () => {
    const res = await expiry({ withinDays: "0" });
    expect(res.status).toBe(400);
  });
});

describe("GET /agents/credential-expiry — permission gate", () => {
  it("403s for an `agent` role (lacks agent:read)", async () => {
    const res = await expiry({}, agentRoleUser.id);
    expect(res.status).toBe(403);
  });

  it("200s for an allowed role (agency_admin)", async () => {
    const res = await expiry();
    expect(res.status).toBe(200);
  });
});
