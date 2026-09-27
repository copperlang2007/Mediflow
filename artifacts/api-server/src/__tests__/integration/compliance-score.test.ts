/**
 * getAgentComplianceScores() (lib/compliance/agentComplianceScore.ts):
 * licenses are judged against the supplied `now` snapshot (not the wall
 * clock), and AHIP counts as complete for passed or waived.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { ahipRecordsTable, stateLicensesTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent, type TestDb } from "../helpers/testDb";

let testDb: TestDb;
let compute: (agentId: string, orgId: string, now: Date) => Promise<
  import("../../lib/compliance/agentComplianceScore").AgentComplianceScore
>;
let org: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  const { getAgentComplianceScores } = await import("../../lib/compliance/agentComplianceScore");
  compute = async (agentId, orgId, now) => {
    const [score] = await getAgentComplianceScores({ orgId, agentIds: [agentId], now });
    return score;
  };
  org = await seedOrg(testDb, { name: "Compliance Score Org" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("getAgentComplianceScores", () => {
  it("judges license expiry against the supplied now, not the wall clock", async () => {
    const agent = await seedAgent(testDb, { orgId: org.id });
    await testDb.insert(stateLicensesTable).values({
      id: `lic-${randomUUID()}`,
      agentId: agent.id,
      stateCode: "FL",
      licenseType: "health",
      status: "active",
      // Long expired today, but still valid at the snapshot below.
      expiryDate: new Date("2021-01-01T00:00:00Z"),
    });
    const score = await compute(agent.id, org.id, new Date("2020-06-01T12:00:00Z"));
    expect(score.activeLicenses).toBe(1);
    expect(score.licenseScore).toBe(100);
  });

  it("counts a waived AHIP record as complete", async () => {
    const agent = await seedAgent(testDb, { orgId: org.id });
    await testDb.insert(ahipRecordsTable).values({
      id: `ahip-${randomUUID()}`,
      agentId: agent.id,
      certificationYear: 2026,
      status: "waived",
    });
    const score = await compute(agent.id, org.id, new Date("2026-05-01T12:00:00Z"));
    expect(score.ahipCompleted).toBe(true);
    expect(score.ahipScore).toBe(100);
  });
});
