/**
 * GET /api/retention/summary and GET /api/retention/birthdays against a real
 * Postgres engine (pglite).
 *
 * Regression: the birthday-window SQL bound JS Dates / numbers as untyped
 * parameters inside `EXTRACT(DOY FROM $1)`, which Postgres 16 rejects with
 * `function pg_catalog.extract(unknown, unknown) is not unique`. The route
 * now casts every bound parameter explicitly.
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
let soonId: string;
const DAY = 86_400_000;

/** A DOB `daysFromNow` days ahead of today (month/day), born in 1950. */
function dobInDays(daysFromNow: number): Date {
  const d = new Date(Date.now() + daysFromNow * DAY);
  return new Date(Date.UTC(1950, d.getUTCMonth(), d.getUTCDate()));
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "retention-summary-org" });
  otherOrg = await seedOrg(testDb);
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });

  const soon = await seedContact(testDb, {
    orgId: org.id,
    firstName: "Soon",
    dob: dobInDays(10),
  });
  soonId = soon.id;
  await seedContact(testDb, {
    orgId: org.id,
    firstName: "Later",
    dob: dobInDays(120),
  });

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
  await seedContact(testDb, { orgId: otherOrg.id, status: "enrolled", dob: dobInDays(10) });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/retention/summary", () => {
  it("returns org-scoped badge counts with numeric fields", async () => {
    const res = await request(app)
      .get("/api/retention/summary")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(typeof res.body.birthdaysInNext30Days).toBe("number");
    expect(typeof res.body.atRiskContacts).toBe("number");
    expect(typeof res.body.openFlags).toBe("number");
    expect(res.body.birthdaysInNext30Days).toBe(1);
    expect(res.body.atRiskContacts).toBe(1);
    expect(res.body.openFlags).toBe(1);
  });
});

describe("GET /api/retention/birthdays", () => {
  it("returns 200 with only contacts whose birthday is in the window", async () => {
    const res = await request(app).get("/api/retention/birthdays").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual([soonId]);
  });

  it("honours ?days=", async () => {
    const res = await request(app)
      .get("/api/retention/birthdays?days=5")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
