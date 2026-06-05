/**
 * Integration tests for the admin "Live Queue" read endpoints
 * (routes/queue.ts → lib/leadQueue/overview.ts):
 *
 *   GET /api/queue/presence        — agents + live availableNow verdict
 *   GET /api/queue/routing/recent  — recent lead_routing decisions, newest first
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
  agentPresenceTable,
  leadRoutingTable,
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
let carrier: { id: string };

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "lqo-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  carrier = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values({ id: carrier.id, orgId: org.id, name: "Acme Health" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /queue/presence", () => {
  it("returns agents with a live availableNow verdict", async () => {
    const avail = await seedAgent(testDb, { orgId: org.id, lastName: "Avail" });
    const stale = await seedAgent(testDb, { orgId: org.id, lastName: "Stale" });
    const away = await seedAgent(testDb, { orgId: org.id, lastName: "Away" });

    await testDb.insert(agentPresenceTable).values([
      // available + fresh TTL → routable now
      {
        agentId: avail.id,
        orgId: org.id,
        status: "available",
        source: "heartbeat",
        expiresAt: FUTURE,
      },
      // available but TTL lapsed → NOT routable
      {
        agentId: stale.id,
        orgId: org.id,
        status: "available",
        source: "heartbeat",
        expiresAt: PAST,
      },
      // explicitly away
      {
        agentId: away.id,
        orgId: org.id,
        status: "away",
        source: "heartbeat",
        expiresAt: FUTURE,
      },
    ]);

    const res = await request(app)
      .get("/api/queue/presence")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.availableCount).toBe(1);

    const byId = Object.fromEntries(
      res.body.agents.map((a: { agentId: string }) => [a.agentId, a]),
    );
    expect(byId[avail.id].availableNow).toBe(true);
    expect(byId[stale.id].availableNow).toBe(false); // expired
    expect(byId[away.id].availableNow).toBe(false); // away
    // Available agents sort to the front.
    expect(res.body.agents[0].agentId).toBe(avail.id);
  });
});

describe("GET /queue/routing/recent", () => {
  it("returns recent decisions newest-first with agent + carrier names", async () => {
    const agent = await seedAgent(testDb, { orgId: org.id, lastName: "Picked" });

    await testDb.insert(leadRoutingTable).values([
      {
        id: `lr-${randomUUID()}`,
        orgId: org.id,
        carrierId: carrier.id,
        stateCode: "FL",
        agentId: agent.id,
        status: "routed",
        candidatePool: 3,
        source: "public",
        presenceFiltered: true,
        createdAt: new Date("2026-06-04T10:00:00Z"),
      },
      {
        id: `lr-${randomUUID()}`,
        orgId: org.id,
        carrierId: carrier.id,
        stateCode: "TX",
        agentId: null,
        status: "no_agent_available",
        candidatePool: 0,
        source: "in_app",
        presenceFiltered: false,
        createdAt: new Date("2026-06-04T11:00:00Z"),
      },
    ]);

    const res = await request(app)
      .get("/api/queue/routing/recent?limit=10")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);

    // Newest first → the 11:00 no_agent_available decision leads.
    const [first, second] = res.body.data;
    expect(first.status).toBe("no_agent_available");
    expect(first.stateCode).toBe("TX");
    expect(first.agentId).toBeNull();
    expect(second.status).toBe("routed");
    expect(second.carrierName).toBe("Acme Health");
    expect(second.agentLastName).toBe("Picked");
  });

  it("rejects an out-of-range limit", async () => {
    const res = await request(app)
      .get("/api/queue/routing/recent?limit=9999")
      .set(withAuth(admin.id));
    expect(res.status).toBe(400);
  });
});
