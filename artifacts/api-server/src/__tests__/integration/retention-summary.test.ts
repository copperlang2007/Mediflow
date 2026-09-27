/**
 * GET /api/retention/summary — nav-badge counts for the retention CRM.
 *
 * Regression: the birthday count interpolated a JS Date straight into
 * `EXTRACT(DOY FROM $1)`. With no type context Postgres cannot resolve the
 * parameter's type, so the whole summary query failed and the route 500'd.
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
import { activitiesTable, retentionFlagsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };

const DAY = 86_400_000;

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb);
  otherOrg = await seedOrg(testDb);
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });

  // Birthday in ~5 days (born 70 years ago) — inside the 30-day window.
  const soon = new Date(Date.now() + 5 * DAY);
  soon.setUTCFullYear(soon.getUTCFullYear() - 70);
  await seedContact(testDb, { orgId: org.id, firstName: "Soon", dob: soon });

  // Birthday in ~120 days — outside the window.
  const later = new Date(Date.now() + 120 * DAY);
  later.setUTCFullYear(later.getUTCFullYear() - 70);
  await seedContact(testDb, { orgId: org.id, firstName: "Later", dob: later });

  // Enrolled, no recent activity -> at risk.
  const quiet = await seedContact(testDb, { orgId: org.id, status: "enrolled" });
  // Enrolled with recent activity -> not at risk.
  const active = await seedContact(testDb, { orgId: org.id, status: "enrolled" });
  await testDb.insert(activitiesTable).values({
    id: `act-${randomUUID()}`,
    orgId: org.id,
    contactId: active.id,
    type: "call_log",
    createdAt: new Date(Date.now() - 2 * DAY),
  });

  await testDb.insert(retentionFlagsTable).values({
    id: `flag-${randomUUID()}`,
    orgId: org.id,
    contactId: quiet.id,
    flagType: "at_risk",
  });

  // Another org's data must not leak into the counts.
  await seedContact(testDb, { orgId: otherOrg.id, status: "enrolled", dob: soon });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/retention/summary", () => {
  it("returns org-scoped badge counts", async () => {
    const res = await request(app)
      .get("/api/retention/summary")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      birthdaysInNext30Days: 1,
      atRiskContacts: 1,
      openFlags: 1,
    });
  });
});
