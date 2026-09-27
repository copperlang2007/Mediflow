/**
 * Router-level audit middleware must only log requests that router handles.
 *
 * Most routers are mounted at the API root, so a bare `router.use(audit…)`
 * ran for every request that passed through on its way to a later router:
 * one GET wrote "org" and "dashboard" read rows, and one POST wrote a row
 * for every earlier router with a write audit — all with the wrong resource.
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

import { eq } from "drizzle-orm";
import { auditLogTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;
let orgId: string;
let admin: { id: string };

// Audit rows are written on response "finish" without awaiting.
const settle = () => new Promise((r) => setTimeout(r, 150));

// The audit log is append-only, so diff against the rows that already exist.
async function rowsFor(run: () => Promise<unknown>) {
  const all = () => handle.db.select().from(auditLogTable).where(eq(auditLogTable.orgId, orgId));
  await settle();
  const before = new Set((await all()).map((r) => r.id));
  await run();
  await settle();
  return (await all()).filter((r) => !before.has(r.id));
}

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  orgId = (await seedOrg(handle.db, { id: "audit-scope-org" })).id;
  admin = await seedUser(handle.db, { orgId, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("router-level audit scoping", () => {
  it("a read elsewhere is not logged as an org, dashboard or audit-log read", async () => {
    const rows = await rowsFor(() => request(app).get("/api/tasks").set(withAuth(admin.id)).expect(200));
    const types = rows.map((r) => r.resourceType);
    expect(types).not.toContain("org");
    expect(types).not.toContain("dashboard");
    expect(types).not.toContain("audit_log");
  });

  it("a router's own read is still logged once", async () => {
    const rows = await rowsFor(() => request(app).get("/api/dashboard/stats").set(withAuth(admin.id)).expect(200));
    expect(rows.filter((r) => r.resourceType === "dashboard")).toHaveLength(1);
    expect(rows.filter((r) => r.resourceType === "org")).toHaveLength(0);
  });

  it("a write is logged only under the router that handled it", async () => {
    const rows = await rowsFor(() =>
      request(app).post("/api/tasks").set(withAuth(admin.id)).send({ title: "Audit scope check" }),
    );
    const writes = rows.filter((r) => r.action !== "read");
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes.map((r) => r.resourceType))).toEqual(new Set(["task_instance"]));
  });
});
