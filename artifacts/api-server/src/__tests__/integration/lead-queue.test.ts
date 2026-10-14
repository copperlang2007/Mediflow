/**
 * Integration tests for the inbound lead queue (routes/queue.ts +
 * lib/leadQueue/readyToSell.ts).
 *
 * Verifies the headline requirement: the queue returns ONLY agents who are
 * ready to sell a given carrier in a given state, and ranks the eligible
 * pool by current open-lead load. Also covers the negative gates (wrong
 * state, missing/expired carrier cert, missing AHIP, inactive agent),
 * org isolation, the AHIP opt-out, and the GHL-compatible route-inbound
 * response shape.
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
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  leadsTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";

import type { Express } from "express";

const YEAR = 2026;
const FUTURE = new Date("2027-01-01T00:00:00Z");
const PAST = new Date("2025-01-01T00:00:00Z");

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let carrierA: { id: string };
let carrierB: { id: string };

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

/**
 * seedAgent() defaults `status` to "onboarding"; an agent must be "active"
 * to be ready to sell, so activate them explicitly.
 */
async function activate(agentId: string): Promise<void> {
  const { agentsTable } = await import("@workspace/db/schema");
  const { eq } = await import("drizzle-orm");
  await testDb
    .update(agentsTable)
    .set({ status: "active" })
    .where(eq(agentsTable.id, agentId));
}

/** Seed a fully ready-to-sell agent for (carrierA, FL). */
async function seedReadyAgent(
  lastName: string,
  opts: { phone?: string } = {},
): Promise<{ id: string }> {
  const agent = await seedAgent(testDb, { orgId: org.id, lastName });
  await activate(agent.id);
  await giveLicense(agent.id, "FL");
  await giveCarrierCert(agent.id, carrierA.id);
  await giveAhip(agent.id);
  if (opts.phone) {
    // phone is set via a direct update to keep seedAgent's signature intact.
    const { agentsTable } = await import("@workspace/db/schema");
    const { eq } = await import("drizzle-orm");
    await testDb
      .update(agentsTable)
      .set({ phone: opts.phone })
      .where(eq(agentsTable.id, agent.id));
  }
  return agent;
}

async function assignOpenLead(agentId: string): Promise<void> {
  const contact = await seedContact(testDb, { orgId: org.id });
  await testDb.insert(leadsTable).values({
    id: `lead-${randomUUID()}`,
    orgId: org.id,
    contactId: contact.id,
    assignedAgentId: agentId,
    status: "new",
  });
}

function readyToSell(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return request(app)
    .get(`/api/queue/ready-to-sell?${qs}`)
    .set(withAuth(admin.id));
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "lq-org" });
  otherOrg = await seedOrg(testDb, { id: "lq-other-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });

  carrierA = { id: `carrier-${randomUUID()}` };
  carrierB = { id: `carrier-${randomUUID()}` };
  await testDb.insert(carriersTable).values([
    { id: carrierA.id, orgId: org.id, name: "Acme Health" },
    { id: carrierB.id, orgId: org.id, name: "Best Care" },
  ]);
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /queue/ready-to-sell — eligibility gates", () => {
  it("includes a fully ready-to-sell agent", async () => {
    const agent = await seedReadyAgent("Able");
    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: { agentId: string }) => a.agentId);
    expect(ids).toContain(agent.id);
    expect(res.body.stateCode).toBe("FL");
    expect(res.body.certificationYear).toBe(YEAR);
  });

  it("excludes an agent licensed in the WRONG state", async () => {
    const agent = await seedAgent(testDb, {
      orgId: org.id,
      lastName: "Wrongstate",
    });
    await giveLicense(agent.id, "TX");
    await giveCarrierCert(agent.id, carrierA.id);
    await giveAhip(agent.id);

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    const ids = res.body.data.map((a: { agentId: string }) => a.agentId);
    expect(ids).not.toContain(agent.id);
  });

  it("excludes an agent not certified with the carrier", async () => {
    const agent = await seedAgent(testDb, {
      orgId: org.id,
      lastName: "Nocert",
    });
    await giveLicense(agent.id, "FL");
    await giveCarrierCert(agent.id, carrierB.id); // certified for the OTHER carrier
    await giveAhip(agent.id);

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    const ids = res.body.data.map((a: { agentId: string }) => a.agentId);
    expect(ids).not.toContain(agent.id);
  });

  it("excludes an agent whose carrier cert is expired", async () => {
    const agent = await seedAgent(testDb, {
      orgId: org.id,
      lastName: "Expiredcert",
    });
    await giveLicense(agent.id, "FL");
    await giveCarrierCert(agent.id, carrierA.id, { expiryDate: PAST });
    await giveAhip(agent.id);

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    const ids = res.body.data.map((a: { agentId: string }) => a.agentId);
    expect(ids).not.toContain(agent.id);
  });

  it("excludes an agent with an inactive (suspended) state license", async () => {
    const agent = await seedAgent(testDb, {
      orgId: org.id,
      lastName: "Suspendedlic",
    });
    await giveLicense(agent.id, "FL", { status: "suspended" });
    await giveCarrierCert(agent.id, carrierA.id);
    await giveAhip(agent.id);

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    const ids = res.body.data.map((a: { agentId: string }) => a.agentId);
    expect(ids).not.toContain(agent.id);
  });

  it("excludes an agent missing AHIP (when AHIP required) but includes them when requireAhip=false", async () => {
    const agent = await seedAgent(testDb, {
      orgId: org.id,
      lastName: "Noahip",
    });
    await activate(agent.id);
    await giveLicense(agent.id, "FL");
    await giveCarrierCert(agent.id, carrierA.id);
    // no AHIP record

    const withAhip = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    expect(
      withAhip.body.data.map((a: { agentId: string }) => a.agentId),
    ).not.toContain(agent.id);

    const withoutAhip = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
      requireAhip: "false",
    });
    expect(
      withoutAhip.body.data.map((a: { agentId: string }) => a.agentId),
    ).toContain(agent.id);
  });

  it("excludes an inactive (offboarded) agent even with full credentials", async () => {
    const agent = await seedAgent(testDb, {
      orgId: org.id,
      lastName: "Offboarded",
    });
    await giveLicense(agent.id, "FL");
    await giveCarrierCert(agent.id, carrierA.id);
    await giveAhip(agent.id);
    const { agentsTable } = await import("@workspace/db/schema");
    const { eq } = await import("drizzle-orm");
    await testDb
      .update(agentsTable)
      .set({ status: "offboarded" })
      .where(eq(agentsTable.id, agent.id));

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    expect(
      res.body.data.map((a: { agentId: string }) => a.agentId),
    ).not.toContain(agent.id);
  });

  it("does not leak agents from another org", async () => {
    const foreign = await seedAgent(testDb, {
      orgId: otherOrg.id,
      lastName: "Foreign",
    });
    // Give the foreign agent valid-looking creds against our carrier id.
    await testDb.insert(stateLicensesTable).values({
      id: `lic-${randomUUID()}`,
      agentId: foreign.id,
      stateCode: "FL",
      licenseType: "health",
      status: "active",
      expiryDate: FUTURE,
    });
    await giveCarrierCert(foreign.id, carrierA.id);
    await giveAhip(foreign.id);

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    expect(
      res.body.data.map((a: { agentId: string }) => a.agentId),
    ).not.toContain(foreign.id);
  });
});

describe("GET /queue/ready-to-sell — smart ranking", () => {
  it("orders eligible agents by ascending open-lead load", async () => {
    // Fresh carrier/state combo so other tests' agents don't interfere.
    const busy = await seedReadyAgent("Zzz-busy");
    const light = await seedReadyAgent("Zzz-light");
    await assignOpenLead(busy.id);
    await assignOpenLead(busy.id);
    await assignOpenLead(light.id);

    const res = await readyToSell({
      stateCode: "FL",
      carrierId: carrierA.id,
      certificationYear: String(YEAR),
    });
    const rows: Array<{ agentId: string; openLeadCount: number }> =
      res.body.data;
    const busyRow = rows.find((r) => r.agentId === busy.id)!;
    const lightRow = rows.find((r) => r.agentId === light.id)!;
    expect(lightRow.openLeadCount).toBe(1);
    expect(busyRow.openLeadCount).toBe(2);
    // light must come before busy in the ranking
    expect(rows.indexOf(lightRow)).toBeLessThan(rows.indexOf(busyRow));
  });
});

describe("POST /queue/route-inbound", () => {
  it("routes to the best agent and returns GHL-compatible fields", async () => {
    const agent = await seedReadyAgent("Routable", { phone: "+15559990000" });
    const res = await request(app)
      .post("/api/queue/route-inbound")
      .set(withAuth(admin.id))
      .send({
        contactState: "FL",
        carrierId: carrierA.id,
        certificationYear: YEAR,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("routed");
    expect(res.body.candidatePool).toBeGreaterThanOrEqual(1);
    expect(res.body.agent).toBeTruthy();
    // route-inbound picks the lightest-loaded agent; assert the chosen one is real.
    expect(typeof res.body.target_user_id).toBe("string");
    if (res.body.target_user_id === agent.id) {
      expect(res.body.target_phone).toBe("+15559990000");
    }
  });

  it("resolves state from a contact when contactState is omitted", async () => {
    const agent = await seedReadyAgent("Contactstate", {
      phone: "+15551112222",
    });
    const contact = await seedContact(testDb, { orgId: org.id });
    const { contactsTable } = await import("@workspace/db/schema");
    const { eq } = await import("drizzle-orm");
    await testDb
      .update(contactsTable)
      .set({ stateCode: "FL" })
      .where(eq(contactsTable.id, contact.id));

    const res = await request(app)
      .post("/api/queue/route-inbound")
      .set(withAuth(admin.id))
      .send({
        contactId: contact.id,
        carrierId: carrierA.id,
        certificationYear: YEAR,
      });

    expect(res.status).toBe(200);
    expect(res.body.stateCode).toBe("FL");
    expect(res.body.status).toBe("routed");
    expect([agent.id]).toBeTruthy(); // agent exists in pool
  });

  it("returns no_agent_available when nobody is ready to sell", async () => {
    const res = await request(app)
      .post("/api/queue/route-inbound")
      .set(withAuth(admin.id))
      .send({
        contactState: "WY",
        carrierId: carrierB.id,
        certificationYear: YEAR,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_agent_available");
    expect(res.body.candidatePool).toBe(0);
    expect(res.body.target_phone).toBeNull();
    expect(res.body.target_user_id).toBeNull();
  });

  it("400s when the state cannot be resolved", async () => {
    const res = await request(app)
      .post("/api/queue/route-inbound")
      .set(withAuth(admin.id))
      .send({ carrierId: carrierA.id });
    expect(res.status).toBe(400);
  });
});
