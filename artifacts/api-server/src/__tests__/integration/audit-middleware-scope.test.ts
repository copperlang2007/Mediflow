/**
 * Regression test: router-level audit middleware must only audit its own
 * router's routes.
 *
 * `routes/index.ts` mounts every feature router at the root, so a
 * `router.use(auditMiddleware(...))` inside one router used to run for every
 * request that passed through it — i.e. for every request handled by a router
 * mounted later. A single `POST /api/invitations` wrote one audit_log row per
 * earlier router, each with the wrong `resourceType`, and every authenticated
 * GET was logged as a read of "user", "org", "dashboard", "agent",
 * "notification" and "audit_log". Each of those middlewares also attached its
 * own `res.on("finish")` listener, which tripped Node's
 * MaxListenersExceededWarning.
 *
 * Each case below makes exactly one request and asserts the exact set of
 * audit rows it produced.
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
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";
import type { TestDbHandle } from "../helpers/testDb";

import type { Express } from "express";

let handle: TestDbHandle;
let app: Express;
let request: typeof import("supertest");

let org: { id: string };
let admin: { id: string };
let agent: { id: string };

const warnings: Error[] = [];
const onWarning = (w: Error): void => {
  warnings.push(w);
};

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "audit-scope-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  agent = await seedAgent(handle.db, { orgId: org.id });

  process.on("warning", onWarning);
});

afterAll(async () => {
  process.off("warning", onWarning);
  await shutdownTestDb();
});

async function auditRowIds(): Promise<Set<string>> {
  const rows = await handle.db
    .select({ id: auditLogTable.id })
    .from(auditLogTable)
    .where(eq(auditLogTable.orgId, org.id));
  return new Set(rows.map((r) => r.id));
}

/**
 * Runs `send`, then waits for the fire-and-forget audit inserts to land
 * (row count stable across several polls) and returns only the new rows.
 */
async function auditRowsFor(
  send: () => Promise<{ status: number }>,
): Promise<{ status: number; rows: Array<typeof auditLogTable.$inferSelect> }> {
  const before = await auditRowIds();
  const res = await send();

  let lastCount = -1;
  let stablePolls = 0;
  for (let i = 0; i < 100 && stablePolls < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const count = (await auditRowIds()).size;
    stablePolls = count === lastCount ? stablePolls + 1 : 0;
    lastCount = count;
  }

  const all = await handle.db
    .select()
    .from(auditLogTable)
    .where(eq(auditLogTable.orgId, org.id));
  return { status: res.status, rows: all.filter((r) => !before.has(r.id)) };
}

describe("router-level auditMiddleware scope", () => {
  it("GET on a router that does not audit reads writes no audit rows", async () => {
    const { status, rows } = await auditRowsFor(() =>
      request(app).get("/api/tasks").set(withAuth(admin.id)),
    );
    expect(status).toBe(200);
    expect(rows.map((r) => r.resourceType)).toEqual([]);
  });

  it("GET on a router that audits reads writes exactly one row for that router", async () => {
    const { status, rows } = await auditRowsFor(() =>
      request(app).get("/api/dashboard/stats").set(withAuth(admin.id)),
    );
    expect(status).toBe(200);
    expect(rows.map((r) => [r.resourceType, r.action])).toEqual([
      ["dashboard", "read"],
    ]);
  });

  it("POST late in the mount order writes exactly one row with that router's resource", async () => {
    const contact = await seedContact(handle.db, { orgId: org.id, status: "lead" });
    const { status, rows } = await auditRowsFor(() =>
      request(app)
        .post("/api/leads")
        .set(withAuth(admin.id))
        .send({ contactId: contact.id, source: "web" }),
    );
    expect(status).toBe(201);
    expect(rows.map((r) => [r.resourceType, r.action])).toEqual([
      ["lead", "create"],
    ]);
  });

  it("POST to the last-mounted router writes exactly one row", async () => {
    const { status, rows } = await auditRowsFor(() =>
      request(app)
        .post("/api/invitations")
        .set(withAuth(admin.id))
        .send({ email: "audit-scope-invitee@example.com", role: "agent" }),
    );
    expect(status).toBeLessThan(500);
    expect(status).not.toBe(404);
    expect(rows.map((r) => r.resourceType)).toEqual(["invitation"]);
  });

  it("routers sharing the /agents prefix audit only the route they own", async () => {
    // licensesRouter owns this route; agents/techstack/ahip/certifications/
    // checklists/tasks/agentDocuments all have routes under /agents too.
    const write = await auditRowsFor(() =>
      request(app)
        .post(`/api/agents/${agent.id}/licenses`)
        .set(withAuth(admin.id))
        .send({ stateCode: "TX", licenseType: "resident", status: "active" }),
    );
    expect(write.status).not.toBe(404);
    expect(write.rows.map((r) => [r.resourceType, r.action])).toEqual([
      ["agent", "create"],
    ]);

    // licensesRouter does not audit reads, so the agentsRouter (which does)
    // must not log this GET as an "agent" read.
    const read = await auditRowsFor(() =>
      request(app)
        .get(`/api/agents/${agent.id}/licenses`)
        .set(withAuth(admin.id)),
    );
    expect(read.status).toBe(200);
    expect(read.rows).toEqual([]);

    // agentsRouter's own reads are still audited.
    const own = await auditRowsFor(() =>
      request(app).get(`/api/agents/${agent.id}`).set(withAuth(admin.id)),
    );
    expect(own.status).toBe(200);
    expect(own.rows.map((r) => [r.resourceType, r.action, r.resourceId])).toEqual([
      ["agent", "read", agent.id],
    ]);
  });

  it("does not trip MaxListenersExceededWarning", () => {
    expect(
      warnings
        .filter((w) => w.name === "MaxListenersExceededWarning")
        .map((w) => w.message),
    ).toEqual([]);
  });
});
