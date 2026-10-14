/**
 * Callback SLA queue — admin endpoint tests (routes/queue.ts → callbacks.ts):
 *
 *   GET  /api/queue/callbacks?status=open  — worked list, SLA-soonest first
 *   POST /api/queue/callbacks/:id/cancel   — mark an open callback cancelled
 *
 * Both are gated `agent:admin`; a lead:read-only role (agent_support) gets 403.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { carriersTable, leadCallbacksTable } from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let carrier: { id: string };

async function seedCallback(opts: {
  slaDueAt: Date;
  status?: string;
}): Promise<string> {
  const id = `cb-${randomUUID()}`;
  await testDb.insert(leadCallbacksTable).values({
    id,
    orgId: org.id,
    contactId: `ghl-${randomUUID()}`,
    carrierId: carrier.id,
    stateCode: "FL",
    certificationYear: 2026,
    status: opts.status ?? "open",
    slaDueAt: opts.slaDueAt,
    attempts: 0,
  });
  return id;
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "lce-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  carrier = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values({ id: carrier.id, orgId: org.id, name: "Acme Health" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /queue/callbacks", () => {
  it("returns open callbacks SLA-soonest first with carrier name", async () => {
    const later = await seedCallback({
      slaDueAt: new Date("2026-06-07T11:00:00Z"),
    });
    const sooner = await seedCallback({
      slaDueAt: new Date("2026-06-07T10:00:00Z"),
    });
    // A non-open callback must not appear in the open list.
    await seedCallback({
      slaDueAt: new Date("2026-06-07T09:00:00Z"),
      status: "resolved",
    });

    const res = await request(app)
      .get("/api/queue/callbacks?status=open")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);

    const ids = res.body.data.map((c: { id: string }) => c.id);
    // Sooner SLA leads.
    expect(ids.indexOf(sooner)).toBeLessThan(ids.indexOf(later));
    expect(ids).not.toContain(
      res.body.data.find((c: { status: string }) => c.status !== "open")?.id,
    );
    const first = res.body.data.find((c: { id: string }) => c.id === sooner);
    expect(first.carrierName).toBe("Acme Health");
    expect(first.stateCode).toBe("FL");
  });
});

describe("POST /queue/callbacks/:id/cancel", () => {
  it("cancels an open callback", async () => {
    const id = await seedCallback({
      slaDueAt: new Date("2026-06-07T12:00:00Z"),
    });
    const res = await request(app)
      .post(`/api/queue/callbacks/${id}/cancel`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const [row] = await testDb
      .select()
      .from(leadCallbacksTable)
      .where(eq(leadCallbacksTable.id, id));
    expect(row.status).toBe("cancelled");
  });

  it("404s cancelling a callback that is not open", async () => {
    const id = await seedCallback({
      slaDueAt: new Date("2026-06-07T12:00:00Z"),
      status: "resolved",
    });
    const res = await request(app)
      .post(`/api/queue/callbacks/${id}/cancel`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });
});

describe("Callback endpoints — admin-only access", () => {
  it("403s a non-admin role (agent_support)", async () => {
    const support = await seedUser(testDb, {
      orgId: org.id,
      role: "agent_support",
    });
    const list = await request(app)
      .get("/api/queue/callbacks")
      .set(withAuth(support.id));
    const cancel = await request(app)
      .post(`/api/queue/callbacks/${randomUUID()}/cancel`)
      .set(withAuth(support.id));
    expect(list.status).toBe(403);
    expect(cancel.status).toBe(403);
  });
});
