/**
 * Churn / retention risk scoring (routes/churnScores.ts):
 *
 *   GET /api/churn/scores[?band=&limit=]  — scored member worked-list
 *   GET /api/churn/summary                — risk-band counts + average
 *
 * The score is a transparent weighted sum of signals (inactivity, open
 * complaint, at-risk flag, first-renewal anniversary). Read-only; gated on
 * `retention_alert:read`.
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
import { eq } from "drizzle-orm";
import {
  contactsTable,
  activitiesTable,
  complaintsTable,
  retentionFlagsTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let scoreMember: typeof import("../../routes/churnScores").scoreMember;

let org: { id: string };
let admin: { id: string };

async function member(opts: { firstName: string; planYear?: number }): Promise<string> {
  const c = await seedContact(testDb, {
    orgId: org.id,
    firstName: opts.firstName,
    status: "enrolled",
  });
  await testDb
    .update(contactsTable)
    .set({ currentPlanType: "MA", planYear: opts.planYear ?? null })
    .where(eq(contactsTable.id, c.id));
  return c.id;
}

async function addActivity(contactId: string, createdAt: Date): Promise<void> {
  await testDb.insert(activitiesTable).values({
    id: `act-${randomUUID()}`,
    orgId: org.id,
    contactId,
    type: "call_log",
    createdAt,
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  scoreMember = (await import("../../routes/churnScores")).scoreMember;

  org = await seedOrg(testDb, { id: "churn-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("scoreMember (pure)", () => {
  const base = { currentYear: 2026, now: new Date("2026-06-01T00:00:00Z") };

  it("scores a freshly-engaged member as low risk", () => {
    const s = scoreMember({
      ...base,
      lastActivityAt: new Date("2026-05-28T00:00:00Z"),
      hasOpenComplaint: false,
      hasAtRiskFlag: false,
      planYear: 2026,
    });
    expect(s.band).toBe("low");
    expect(s.score).toBe(0);
  });

  it("stacks signals into a high-risk score with reasons", () => {
    const s = scoreMember({
      ...base,
      lastActivityAt: null, // +35
      hasOpenComplaint: true, // +25
      hasAtRiskFlag: true, // +20
      planYear: 2025, // first renewal (+15)
    });
    // 35 + 25 + 25 + 15 = 100 (capped).
    expect(s.score).toBe(100);
    expect(s.band).toBe("high");
    expect(s.reasons.length).toBe(4);
  });

  it("caps the score at 100", () => {
    const s = scoreMember({
      ...base,
      lastActivityAt: null,
      hasOpenComplaint: true,
      hasAtRiskFlag: true,
      planYear: 2025,
    });
    expect(s.score).toBeLessThanOrEqual(100);
  });
});

describe("GET /churn/scores + /summary", () => {
  it("ranks members by risk and explains why, using the complaint signal", async () => {
    // Low risk: recent activity, current plan year.
    const calm = await member({ firstName: "Calm", planYear: 2026 });
    await addActivity(calm, new Date("2026-05-25T00:00:00Z"));

    // High risk: no activity + an open complaint + first renewal.
    const risky = await member({ firstName: "Risky", planYear: 2025 });
    await testDb.insert(complaintsTable).values({
      id: `cmpl-${randomUUID()}`,
      orgId: org.id,
      contactId: risky,
      subject: "Service issue",
      status: "open",
      severity: "high",
      category: "benefits",
      source: "beneficiary_direct",
    });

    // Medium risk: an unresolved at-risk flag only.
    const mid = await member({ firstName: "Mid", planYear: 2026 });
    await addActivity(mid, new Date("2026-05-25T00:00:00Z")); // recent, so inactivity doesn't fire
    await testDb.insert(retentionFlagsTable).values({
      id: `rf-${randomUUID()}`,
      orgId: org.id,
      contactId: mid,
      flagType: "at_risk",
    });

    const res = await request(app).get("/api/churn/scores").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((m: { contactId: string }) => [m.contactId, m]));

    expect(byId[risky].band).toBe("high");
    expect(byId[risky].reasons).toContain("Open complaint on file");
    expect(byId[mid].band).toBe("medium");
    expect(byId[calm].band).toBe("low");

    // Highest risk sorts first.
    expect(res.body[0].contactId).toBe(risky);
  });

  it("summary reports band counts and an average", async () => {
    const res = await request(app).get("/api/churn/summary").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.totalMembers).toBeGreaterThanOrEqual(3);
    expect(res.body.high).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.averageScore).toBe("number");
  });

  it("filters by band", async () => {
    const res = await request(app)
      .get("/api/churn/scores?band=high")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    for (const m of res.body) expect(m.band).toBe("high");
  });

  it("403s a role without retention_alert read (agent)", async () => {
    const agent = await seedUser(testDb, { orgId: org.id, role: "agent" });
    const res = await request(app).get("/api/churn/scores").set(withAuth(agent.id));
    expect(res.status).toBe(403);
  });
});
