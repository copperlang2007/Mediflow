/**
 * AEP Command Center — readiness cockpit endpoint (routes/aepCockpit.ts):
 *
 *   GET /api/aep-cockpit[?year=YYYY]
 *
 * Rolls the AEP annual-review tasks (auto_assign_trigger `aep_renewal:<year>:`)
 * and the current MA/MAPD member book into a readiness summary: members up for
 * renewal, review-task coverage, task status (active / completed / overdue),
 * a per-agent breakdown, and the season's key dates. Read-only; gated on
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
import { contactsTable, taskInstancesTable } from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

const YEAR = 2026;

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let agent: { id: string };

async function seedMember(opts: {
  planType: "MA" | "MAPD" | "PDP";
  status: "enrolled" | "retained" | "lead";
}): Promise<string> {
  const c = await seedContact(testDb, { orgId: org.id, status: opts.status });
  await testDb
    .update(contactsTable)
    .set({ currentPlanType: opts.planType, assignedAgentId: agent.id })
    .where(eq(contactsTable.id, c.id));
  return c.id;
}

async function seedRenewalTask(opts: {
  contactId: string;
  status: "open" | "in_progress" | "completed" | "cancelled";
  dueDate: Date;
}): Promise<void> {
  await testDb.insert(taskInstancesTable).values({
    id: `task-${randomUUID()}`,
    orgId: org.id,
    contactId: opts.contactId,
    agentId: agent.id,
    title: "Annual review",
    status: opts.status,
    priority: "high",
    dueDate: opts.dueDate,
    createdBy: "system",
    autoAssignTrigger: `aep_renewal:${YEAR}:${opts.contactId}`,
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "aepc-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  agent = await seedAgent(testDb, { orgId: org.id, firstName: "Dana", lastName: "Cole" });

  // 4 eligible MA/MAPD members; one PDP and one lead that must NOT count.
  const m1 = await seedMember({ planType: "MA", status: "enrolled" });
  const m2 = await seedMember({ planType: "MAPD", status: "retained" });
  const m3 = await seedMember({ planType: "MA", status: "enrolled" });
  await seedMember({ planType: "MA", status: "enrolled" }); // m4: eligible, no task
  await seedMember({ planType: "PDP", status: "enrolled" }); // ineligible plan
  await seedMember({ planType: "MA", status: "lead" }); // ineligible status

  // Tasks: m1 completed, m2 open (future due), m3 open + overdue. m4 has none.
  await seedRenewalTask({ contactId: m1, status: "completed", dueDate: new Date(Date.UTC(YEAR, 8, 30)) });
  // Due far in the future, so it never turns overdue as the calendar moves on.
  await seedRenewalTask({ contactId: m2, status: "open", dueDate: new Date("2999-01-01T00:00:00Z") });
  await seedRenewalTask({ contactId: m3, status: "open", dueDate: new Date("2000-01-01T00:00:00Z") });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /aep-cockpit", () => {
  it("summarizes member book, task coverage, and overdue for the season", async () => {
    const res = await request(app)
      .get(`/api/aep-cockpit?year=${YEAR}`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.seasonYear).toBe(YEAR);

    // 4 eligible MA/MAPD members (PDP + lead excluded).
    expect(body.members.total).toBe(4);
    expect(body.members.byPlanType.MA).toBe(3);
    expect(body.members.byPlanType.MAPD).toBe(1);

    // 3 have a review task; 1 (m4) does not.
    expect(body.members.withReviewTask).toBe(3);
    expect(body.members.withoutReviewTask).toBe(1);

    // Tasks: 3 total, 2 active, 1 completed, 1 overdue (m3).
    expect(body.reviewTasks.total).toBe(3);
    expect(body.reviewTasks.active).toBe(2);
    expect(body.reviewTasks.completed).toBe(1);
    expect(body.reviewTasks.overdue).toBe(1);

    // Key dates: review deadline before Oct 1; renewal is next Jan 1.
    expect(new Date(body.keyDates.reviewDeadline).getUTCMonth()).toBe(8); // September
    expect(new Date(body.keyDates.renewalDate).getUTCFullYear()).toBe(YEAR + 1);

    // Per-agent: Dana Cole owns all 3.
    const dana = body.byAgent.find((a: { agentName: string }) => a.agentName === "Dana Cole");
    expect(dana).toBeTruthy();
    expect(dana.total).toBe(3);
    expect(dana.completed).toBe(1);
    expect(dana.overdue).toBe(1);
  });

  it("returns an empty-but-valid shape for a season with no data", async () => {
    const res = await request(app)
      .get(`/api/aep-cockpit?year=2099`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.reviewTasks.total).toBe(0);
    expect(res.body.members.coverageRate).toBe(0);
  });

  it("403s a role without dashboard read (agent)", async () => {
    const plainAgent = await seedUser(testDb, { orgId: org.id, role: "agent" });
    const res = await request(app)
      .get("/api/aep-cockpit")
      .set(withAuth(plainAgent.id));
    expect(res.status).toBe(403);
  });
});
