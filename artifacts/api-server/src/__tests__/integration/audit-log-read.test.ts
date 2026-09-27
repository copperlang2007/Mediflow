/**
 * GET /api/audit-log and GET /api/admin/audit-log — the entries are enriched
 * with the acting user's name.
 *
 * Regression: the name lookup used sql`id = ANY(${userIds})`. Drizzle expands
 * a JS array inside a sql template into a parenthesised parameter list, so
 * Postgres saw `ANY(($1))` and failed with "malformed array literal" (or, for
 * several users, "op ANY/ALL (array) requires array on right side"). Any page
 * with at least one attributed entry returned 500.
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
import { auditLogTable } from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  withMfaAuth,
} from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let org: { id: string };
let admin: { id: string };
let other: { id: string };

type Entry = { userId: string | null; userFullName: string | null };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb);
  admin = await seedUser(testDb, {
    orgId: org.id,
    role: "agency_admin",
    fullName: "Ada Admin",
  });
  other = await seedUser(testDb, {
    orgId: org.id,
    role: "agent",
    fullName: "Otto Agent",
  });

  // Two distinct attributed users plus one system entry.
  for (const userId of [admin.id, other.id, null]) {
    await testDb.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: org.id,
      userId,
      action: "update",
      resourceType: "contact",
    });
  }
});

afterAll(async () => {
  await shutdownTestDb();
});

function namesById(entries: Entry[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of entries) if (e.userId) out[e.userId] = e.userFullName;
  return out;
}

describe("audit log reads", () => {
  it("GET /api/audit-log returns entries with user names", async () => {
    const res = await request(app).get("/api/audit-log").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const names = namesById(res.body.entries);
    expect(names[admin.id]).toBe("Ada Admin");
    expect(names[other.id]).toBe("Otto Agent");
  });

  it("GET /api/audit-log works when only one user is attributed", async () => {
    const res = await request(app)
      .get(`/api/audit-log?userId=${other.id}`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries[0].userFullName).toBe("Otto Agent");
  });

  it("GET /api/admin/audit-log returns entries with user names", async () => {
    const res = await request(app)
      .get("/api/admin/audit-log")
      .set(withMfaAuth(admin.id, true));
    expect(res.status).toBe(200);
    const names = namesById(res.body.entries);
    expect(names[admin.id]).toBe("Ada Admin");
    expect(names[other.id]).toBe("Otto Agent");
  });
});
