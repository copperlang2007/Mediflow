/**
 * Integration tests for the admin routing-analytics endpoint
 * (routes/queue.ts → lib/leadQueue/overview.ts):
 *
 *   GET /api/queue/routing/stats?sinceHours=24
 *     — windowed routing stats (totals, routed rate, avg pool, by-carrier,
 *       by-state) + the carrier×state coverage-gap list.
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
let acme: { id: string };
let globex: { id: string };

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

// Helpers to place rows at a known age relative to "now".
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

async function routing(values: {
  carrierId: string;
  stateCode: string;
  status: "routed" | "no_agent_available";
  agentId?: string | null;
  candidatePool?: number;
  createdAt: Date;
}) {
  await testDb.insert(leadRoutingTable).values({
    id: `lr-${randomUUID()}`,
    orgId: org.id,
    carrierId: values.carrierId,
    stateCode: values.stateCode,
    agentId: values.agentId ?? null,
    status: values.status,
    candidatePool: values.candidatePool ?? 0,
    source: "in_app",
    presenceFiltered: false,
    createdAt: values.createdAt,
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "lqa-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });

  acme = { id: `carrier-${randomUUID()}` };
  globex = { id: `carrier-${randomUUID()}` };
  await testDb.insert(carriersTable).values([
    { id: acme.id, orgId: org.id, name: "Acme Health" },
    { id: globex.id, orgId: org.id, name: "Globex Care" },
  ]);

  const agent = await seedAgent(testDb, { orgId: org.id, lastName: "Picked" });

  // --- In-window rows (within 24h) ---
  // Acme/FL: 2 routed (pools 2 & 4), 1 no_agent.
  await routing({
    carrierId: acme.id,
    stateCode: "FL",
    status: "routed",
    agentId: agent.id,
    candidatePool: 2,
    // 40m ago — comfortably inside both the 1h and 24h windows (avoids the
    // exact-boundary flake of placing it at hoursAgo(1)).
    createdAt: new Date(Date.now() - 40 * 60 * 1000),
  });
  await routing({
    carrierId: acme.id,
    stateCode: "FL",
    status: "routed",
    agentId: agent.id,
    candidatePool: 4,
    createdAt: hoursAgo(2),
  });
  await routing({
    carrierId: acme.id,
    stateCode: "FL",
    status: "no_agent_available",
    candidatePool: 0,
    createdAt: hoursAgo(3),
  });
  // Acme/TX: 3 no_agent (the worst gap), latest at 30m.
  await routing({
    carrierId: acme.id,
    stateCode: "TX",
    status: "no_agent_available",
    createdAt: hoursAgo(5),
  });
  await routing({
    carrierId: acme.id,
    stateCode: "TX",
    status: "no_agent_available",
    createdAt: hoursAgo(4),
  });
  await routing({
    carrierId: acme.id,
    stateCode: "TX",
    status: "no_agent_available",
    createdAt: new Date(Date.now() - 30 * 60 * 1000),
  });
  // Globex/CA: 1 no_agent.
  await routing({
    carrierId: globex.id,
    stateCode: "CA",
    status: "no_agent_available",
    createdAt: hoursAgo(6),
  });

  // --- Out-of-window row (40h ago) — must be excluded from the 24h window. ---
  await routing({
    carrierId: globex.id,
    stateCode: "NY",
    status: "no_agent_available",
    createdAt: hoursAgo(40),
  });

  // One available agent right now (for the coverage-gap availableNow count).
  await testDb.insert(agentPresenceTable).values({
    agentId: agent.id,
    orgId: org.id,
    status: "available",
    source: "heartbeat",
    expiresAt: FUTURE,
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /queue/routing/stats", () => {
  it("computes window totals, routed rate, avg pool, and breakdowns", async () => {
    const res = await request(app)
      .get("/api/queue/routing/stats?sinceHours=24")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.sinceHours).toBe(24);

    const { stats } = res.body;
    // 7 in-window decisions: 2 routed + 5 no_agent (NY row is out of window).
    expect(stats.total).toBe(7);
    expect(stats.routed).toBe(2);
    expect(stats.noAgent).toBe(5);
    expect(stats.routedRate).toBeCloseTo(2 / 7, 5);
    // Avg pool over routed rows only: (2 + 4) / 2 = 3.
    expect(stats.avgCandidatePool).toBeCloseTo(3, 5);
  });

  it("breaks down by carrier and by state", async () => {
    const res = await request(app)
      .get("/api/queue/routing/stats?sinceHours=24")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const { stats } = res.body;

    const byCarrier = Object.fromEntries(
      stats.byCarrier.map((c: { carrierId: string }) => [c.carrierId, c]),
    );
    expect(byCarrier[acme.id].carrierName).toBe("Acme Health");
    expect(byCarrier[acme.id].routed).toBe(2);
    expect(byCarrier[acme.id].noAgent).toBe(4); // FL 1 + TX 3
    expect(byCarrier[globex.id].routed).toBe(0);
    expect(byCarrier[globex.id].noAgent).toBe(1); // CA only (NY excluded)

    const byState = Object.fromEntries(
      stats.byState.map((s: { stateCode: string }) => [s.stateCode, s]),
    );
    expect(byState.FL.routed).toBe(2);
    expect(byState.FL.noAgent).toBe(1);
    expect(byState.TX.noAgent).toBe(3);
    expect(byState.CA.noAgent).toBe(1);
    expect(byState.NY).toBeUndefined(); // out of window
  });

  it("lists coverage gaps ordered by no-agent count desc, with availableNow", async () => {
    const res = await request(app)
      .get("/api/queue/routing/stats?sinceHours=24")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const gaps = res.body.coverageGaps as Array<{
      carrierId: string;
      stateCode: string;
      noAgentCount: number;
      availableNow: number;
      carrierName: string | null;
      lastOccurrence: string;
    }>;

    // 3 carrier×state pairs missed in-window: Acme/FL, Acme/TX, Globex/CA.
    expect(gaps.length).toBe(3);
    // Worst first: Acme/TX with 3.
    expect(gaps[0].carrierId).toBe(acme.id);
    expect(gaps[0].stateCode).toBe("TX");
    expect(gaps[0].noAgentCount).toBe(3);
    expect(gaps[0].carrierName).toBe("Acme Health");
    // One agent available org-wide right now.
    expect(gaps[0].availableNow).toBe(1);
    // NY (out of window) absent.
    expect(gaps.some((g) => g.stateCode === "NY")).toBe(false);
  });

  it("respects the window filter (1h excludes older misses)", async () => {
    const res = await request(app)
      .get("/api/queue/routing/stats?sinceHours=1")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const { stats, coverageGaps } = res.body;
    // Within 1h: Acme/FL routed (40m) + Acme/TX no_agent (30m). The 2h/3h+ rows drop.
    expect(stats.routed).toBe(1);
    expect(stats.noAgent).toBe(1);
    expect(coverageGaps.length).toBe(1);
    expect(coverageGaps[0].stateCode).toBe("TX");
    expect(coverageGaps[0].noAgentCount).toBe(1);
  });

  it("rejects an out-of-range sinceHours", async () => {
    const res = await request(app)
      .get("/api/queue/routing/stats?sinceHours=99999")
      .set(withAuth(admin.id));
    expect(res.status).toBe(400);
  });

  it("403s a lead:read role that is not admin-tier (agent_support)", async () => {
    const support = await seedUser(testDb, {
      orgId: org.id,
      role: "agent_support",
    });
    const res = await request(app)
      .get("/api/queue/routing/stats")
      .set(withAuth(support.id));
    expect(res.status).toBe(403);
  });
});
