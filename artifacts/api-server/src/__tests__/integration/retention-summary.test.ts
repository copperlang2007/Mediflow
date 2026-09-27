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
import { retentionFlagsTable } from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let soonId: string;

/** A DOB `daysFromNow` days ahead of today (month/day), born in 1950. */
function dobInDays(daysFromNow: number): Date {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return new Date(Date.UTC(1950, d.getUTCMonth(), d.getUTCDate()));
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "retention-summary-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });

  // Birthday comfortably inside the 30-day window (avoids day-boundary edges).
  const soon = await seedContact(testDb, {
    orgId: org.id,
    firstName: "Soon",
    status: "enrolled",
    dob: dobInDays(10),
  });
  soonId = soon.id;
  // Birthday well outside the window.
  await seedContact(testDb, {
    orgId: org.id,
    firstName: "Later",
    status: "enrolled",
    dob: dobInDays(120),
  });
  await testDb.insert(retentionFlagsTable).values({
    id: `rf-${randomUUID()}`,
    orgId: org.id,
    contactId: soon.id,
    flagType: "at_risk",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/retention/summary", () => {
  it("returns 200 with numeric counts", async () => {
    const res = await request(app).get("/api/retention/summary").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(typeof res.body.birthdaysInNext30Days).toBe("number");
    expect(typeof res.body.atRiskContacts).toBe("number");
    expect(typeof res.body.openFlags).toBe("number");
    expect(res.body.birthdaysInNext30Days).toBe(1);
    // Both contacts are enrolled with no activity in the last 60 days.
    expect(res.body.atRiskContacts).toBe(2);
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
