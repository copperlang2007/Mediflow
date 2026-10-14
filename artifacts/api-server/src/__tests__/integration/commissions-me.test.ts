/**
 * Agent self-serve commission portal integration suite.
 *
 * Exercises GET /api/commissions/me — the agent-facing counterpart to the
 * admin commission surfaces. The endpoint resolves the caller's agent row
 * the same way the queue heartbeat does (agentsTable.userId + orgId) and
 * returns ONLY that agent's payouts plus a paid-vs-pending summary.
 *
 * Asserts:
 *   - a linked agent sees only their own statements
 *   - the paid/pending summary math is correct
 *   - a second agent's statements are excluded (isolation)
 *   - a user with no linked agent gets 404
 *
 * Mirrors commissions.test.ts: vi.hoisted-bound db/auth/jobs mocks,
 * supertest against the real express app, pglite-backed seeds.
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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentCommissionPayoutsTable, agentsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  type TestDb,
} from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: { db: TestDb };

let org: { id: string };

// Agent A: linked to user A, with paid + pending payouts.
let userA: { id: string };
let agentA: { id: string };
// Agent B: a different agent in the same org (isolation check).
let userB: { id: string };
let agentB: { id: string };
// User with no linked agent record at all → expects 404.
let orphanUser: { id: string };

async function insertPayout(
  db: TestDb,
  opts: {
    orgId: string;
    agentId: string;
    periodStart: string;
    periodEnd: string;
    earned: string;
    paid?: string;
    status?: string;
    paidAt?: Date | null;
  },
): Promise<void> {
  await db.insert(agentCommissionPayoutsTable).values({
    id: `payout-${randomUUID()}`,
    orgId: opts.orgId,
    agentId: opts.agentId,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    earned: opts.earned,
    paid: opts.paid ?? "0",
    status: opts.status ?? "open",
    paidAt: opts.paidAt ?? null,
  });
}

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: `me-org-${randomUUID()}` });

  userA = await seedUser(handle.db, { orgId: org.id, role: "agent" });
  agentA = await seedAgent(handle.db, { orgId: org.id });
  // Link agent A → user A the same way production does (agents.user_id).
  await handle.db
    .update(agentsTable)
    .set({ userId: userA.id })
    .where(eq(agentsTable.id, agentA.id));

  userB = await seedUser(handle.db, { orgId: org.id, role: "agent" });
  agentB = await seedAgent(handle.db, { orgId: org.id });
  await handle.db
    .update(agentsTable)
    .set({ userId: userB.id })
    .where(eq(agentsTable.id, agentB.id));

  orphanUser = await seedUser(handle.db, { orgId: org.id, role: "agent" });

  // Agent A: two paid, one pending (open), one pending (held).
  await insertPayout(handle.db, {
    orgId: org.id,
    agentId: agentA.id,
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
    earned: "100.00",
    paid: "100.00",
    status: "paid",
    paidAt: new Date("2025-02-05T00:00:00Z"),
  });
  await insertPayout(handle.db, {
    orgId: org.id,
    agentId: agentA.id,
    periodStart: "2025-02-01",
    periodEnd: "2025-02-28",
    earned: "50.00",
    paid: "50.00",
    status: "paid",
    paidAt: new Date("2025-03-05T00:00:00Z"),
  });
  await insertPayout(handle.db, {
    orgId: org.id,
    agentId: agentA.id,
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    earned: "75.00",
    paid: "0",
    status: "open",
  });
  await insertPayout(handle.db, {
    orgId: org.id,
    agentId: agentA.id,
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    earned: "25.00",
    paid: "0",
    status: "held",
  });

  // Agent B: one paid statement that must NOT leak into agent A's view.
  await insertPayout(handle.db, {
    orgId: org.id,
    agentId: agentB.id,
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
    earned: "999.00",
    paid: "999.00",
    status: "paid",
    paidAt: new Date("2025-02-05T00:00:00Z"),
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/commissions/me", () => {
  it("returns only the caller's own statements, most recent first", async () => {
    const res = await request(app)
      .get("/api/commissions/me")
      .set(withAuth(userA.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(4);
    // Every returned statement belongs to agent A.
    for (const s of res.body.data) {
      expect(s.agentId).toBe(agentA.id);
    }
    // Ordered by periodStart desc (April first, January last).
    expect(res.body.data[0].periodStart).toBe("2025-04-01");
    expect(res.body.data[3].periodStart).toBe("2025-01-01");
    expect(typeof res.body.asOf).toBe("string");
  });

  it("computes the paid-vs-pending summary correctly", async () => {
    const res = await request(app)
      .get("/api/commissions/me")
      .set(withAuth(userA.id));
    expect(res.status).toBe(200);
    const { summary } = res.body;
    // Paid = 100 + 50; pending (open 75 + held 25) = 100.
    expect(summary.totalPaid).toBeCloseTo(150.0, 2);
    expect(summary.totalPending).toBeCloseTo(100.0, 2);
    expect(summary.paidCount).toBe(2);
    expect(summary.pendingCount).toBe(2);
    expect(summary.statementCount).toBe(4);
  });

  it("isolates agents — agent B's $999 statement never appears for agent A", async () => {
    const res = await request(app)
      .get("/api/commissions/me")
      .set(withAuth(userA.id));
    expect(res.status).toBe(200);
    const leaked = res.body.data.find(
      (s: { paid: string | number }) => Number(s.paid) === 999,
    );
    expect(leaked).toBeUndefined();

    // And agent B sees only their own single statement.
    const resB = await request(app)
      .get("/api/commissions/me")
      .set(withAuth(userB.id));
    expect(resB.status).toBe(200);
    expect(resB.body.data.length).toBe(1);
    expect(resB.body.data[0].agentId).toBe(agentB.id);
    expect(resB.body.summary.totalPaid).toBeCloseTo(999.0, 2);
  });

  it("returns 404 when the caller has no linked agent record", async () => {
    const res = await request(app)
      .get("/api/commissions/me")
      .set(withAuth(orphanUser.id));
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/commissions/me");
    expect(res.status).toBe(401);
  });
});
