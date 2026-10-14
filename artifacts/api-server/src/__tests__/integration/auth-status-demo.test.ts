/**
 * GET /api/auth/status in demo mode.
 *
 * Demo mode never mounts the sign-in middleware, so the route must resolve the
 * seeded demo user itself (like requireAuth does) instead of calling
 * getAuth(), which throws a 500. Outside demo mode — and always under
 * NODE_ENV=production — it keeps requiring a real sign-in.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let demoUser: { id: string; orgId: string };
let otherUser: { id: string; orgId: string };

const ORIGINAL = {
  DEMO_MODE: process.env["DEMO_MODE"],
  NODE_ENV: process.env["NODE_ENV"],
  DEMO_USER_ID: process.env["DEMO_USER_ID"],
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  const org = await seedOrg(testDb, { id: "auth-status-demo-org" });
  demoUser = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  otherUser = await seedUser(testDb, { orgId: org.id, role: "agent" });
});

afterEach(restoreEnv);

afterAll(async () => {
  restoreEnv();
  await shutdownTestDb();
});

describe("GET /api/auth/status", () => {
  it("resolves the seeded demo user in demo mode, without a sign-in", async () => {
    process.env["DEMO_MODE"] = "true";
    process.env["NODE_ENV"] = "development";
    process.env["DEMO_USER_ID"] = demoUser.id;

    const res = await request(app).get("/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provisioned: true,
      active: true,
      orgId: demoUser.orgId,
      role: "agency_admin",
    });
  });

  it("ignores the demo user outside demo mode and reports the signed-in user", async () => {
    delete process.env["DEMO_MODE"];
    process.env["DEMO_USER_ID"] = demoUser.id;

    const res = await request(app).get("/api/auth/status").set(withAuth(otherUser.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provisioned: true, role: "agent" });
  });

  it("still requires a session outside demo mode", async () => {
    delete process.env["DEMO_MODE"];
    const res = await request(app).get("/api/auth/status");
    expect(res.status).toBe(401);
  });

  it("never uses the demo user under NODE_ENV=production", async () => {
    process.env["DEMO_MODE"] = "true";
    process.env["NODE_ENV"] = "production";
    process.env["DEMO_USER_ID"] = demoUser.id;

    const res = await request(app).get("/api/auth/status");
    expect(res.status).toBe(401);
  });
});
