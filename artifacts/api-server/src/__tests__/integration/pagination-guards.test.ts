/**
 * Integration + unit test: pagination guards.
 *
 * `safeLimit` / `safeOffset` (lib/listGuards.ts) are the canonical helpers
 * applied across list endpoints (PR #35) so that user-supplied `?limit=` and
 * `?offset=` values can never:
 *   - Exceed a per-route ceiling (1000 for light lists, 500 for heavy).
 *   - Be negative, NaN, or otherwise invalid.
 *
 * This file covers both the helper itself (pure unit tests) and a couple of
 * production list endpoints to confirm the helper is wired correctly.
 *
 * Endpoints exercised:
 *   - GET /contacts            — uses safeLimit(limit, 50, 1000) and
 *                                safeOffset(offset).
 *   - GET /admin/audit-log     — uses safeLimit(limit, 50, 500).
 *   - GET /agents              — uses safeLimit(limit, 50, 1000) and
 *                                safeOffset(offset).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import {
  contactsTable,
  agentsTable,
  auditLogTable,
} from "@workspace/db/schema";
import { safeLimit, safeOffset } from "../../lib/listGuards";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;

let org: { id: string };
let superAdmin: { id: string };
let agentSupport: { id: string };

const SEED_CONTACT_COUNT = 1500;
const SEED_AGENT_COUNT = 1100;
const SEED_AUDIT_COUNT = 600;

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: "pagination-org" });
  superAdmin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
  agentSupport = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent_support",
  });

  // Bulk seed via raw INSERT for speed. Per-row INSERTs through drizzle would
  // take ~30s for 1500 rows on pglite; a multi-row INSERT runs in <1s.
  const contactValues: string[] = [];
  for (let i = 0; i < SEED_CONTACT_COUNT; i++) {
    const id = `pgct-${i}-${randomUUID().slice(0, 8)}`;
    contactValues.push(
      `('${id}', '${org.id}', 'First${i}', 'Last${i}', 'lead')`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO contacts (id, org_id, first_name, last_name, status) VALUES ${contactValues.join(",")};`,
  );

  const agentValues: string[] = [];
  for (let i = 0; i < SEED_AGENT_COUNT; i++) {
    const id = `pgag-${i}-${randomUUID().slice(0, 8)}`;
    agentValues.push(
      `('${id}', '${org.id}', 'AgentFirst${i}', 'AgentLast${i}', 'a${i}@x.test')`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO agents (id, org_id, first_name, last_name, email) VALUES ${agentValues.join(",")};`,
  );

  // Audit-log entries with userId = NULL so the route's enrichment query
  // (`userId = ANY($1)`) is short-circuited — pglite's bound-parameter
  // handling for that exact form differs from node-postgres in a way that's
  // tangential to the cap-clamping behaviour under test.
  const auditValues: string[] = [];
  for (let i = 0; i < SEED_AUDIT_COUNT; i++) {
    const id = randomUUID();
    auditValues.push(
      `('${id}', '${org.id}', NULL, 'read', 'test', NULL)`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO audit_log (id, org_id, user_id, action, resource_type, resource_id) VALUES ${auditValues.join(",")};`,
  );
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("safeLimit / safeOffset (pure unit)", () => {
  it("safeLimit caps a too-large value at the route max", () => {
    expect(safeLimit("99999", 50, 1000)).toBe(1000);
  });

  it("safeLimit returns the default for undefined input", () => {
    expect(safeLimit(undefined, 50, 1000)).toBe(50);
  });

  it("safeLimit returns the default for non-numeric input", () => {
    expect(safeLimit("abc", 50, 1000)).toBe(50);
  });

  it("safeLimit returns the default for negative input", () => {
    expect(safeLimit("-5", 50, 1000)).toBe(50);
  });

  it("safeLimit returns the default for zero", () => {
    expect(safeLimit("0", 50, 1000)).toBe(50);
  });

  it("safeLimit accepts a value within bounds", () => {
    expect(safeLimit("250", 50, 1000)).toBe(250);
  });

  it("safeOffset rejects negative values", () => {
    expect(safeOffset("-100")).toBe(0);
  });

  it("safeOffset rejects non-numeric values", () => {
    expect(safeOffset("abc")).toBe(0);
  });

  it("safeOffset returns 0 for undefined", () => {
    expect(safeOffset(undefined)).toBe(0);
  });

  it("safeOffset accepts a non-negative value", () => {
    expect(safeOffset("75")).toBe(75);
  });
});

describe("Pagination guards on list endpoints", () => {
  it("GET /contacts?limit=99999 caps response well under the global hard cap", async () => {
    const res = await request(app)
      .get("/api/contacts?limit=99999")
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Hard upper bound: even the loosest list cap is 1000.
    expect(res.body.data.length).toBeLessThanOrEqual(1000);
    // Floor: we seeded SEED_CONTACT_COUNT > 1000, so a healthy cap MUST
    // truncate to fewer rows than were seeded.
    expect(res.body.data.length).toBeLessThan(SEED_CONTACT_COUNT);
  });

  it("GET /contacts?limit=-5 falls back to the default (50)", async () => {
    const res = await request(app)
      .get("/api/contacts?limit=-5")
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(50);
  });

  it("GET /contacts?offset=-100 clamps offset to 0 (does not reach Postgres)", async () => {
    const res = await request(app)
      .get("/api/contacts?offset=-100&limit=10")
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(10);
  });

  it("GET /admin/audit-log?limit=99999 caps response at <= 500 (heavy-list cap)", async () => {
    // Reset audit_log and re-seed with userId=NULL only so the route's
    // enrichment query (`SELECT ... WHERE id = ANY($1)`) is short-circuited.
    // pglite's bound-array handling for that exact form differs from
    // node-postgres in a way that's tangential to the cap-clamping under
    // test. TRUNCATE bypasses the immutability triggers (DELETE-only).
    // The audit middleware writes its own log entry on `res.on("finish")`,
    // i.e. AFTER the response is sent, so it can't pollute this GET.
    await handle.pg.exec(`TRUNCATE TABLE "audit_log";`);
    const auditValues: string[] = [];
    for (let i = 0; i < SEED_AUDIT_COUNT; i++) {
      const id = randomUUID();
      auditValues.push(
        `('${id}', '${org.id}', NULL, 'read', 'test', NULL)`,
      );
    }
    await handle.pg.exec(
      `INSERT INTO audit_log (id, org_id, user_id, action, resource_type, resource_id) VALUES ${auditValues.join(",")};`,
    );

    const res = await request(app)
      .get("/api/admin/audit-log?limit=99999")
      .set(withAuth(superAdmin.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("entries");
    expect(res.body.entries.length).toBeLessThanOrEqual(500);
    expect(res.body.limit).toBeLessThanOrEqual(500);
    // Sanity: more than 500 rows existed; cap MUST have truncated.
    expect(res.body.total).toBeGreaterThan(500);
  });

  it("GET /agents?limit=99999 caps response at <= 1000 (light-list cap)", async () => {
    const res = await request(app)
      .get("/api/agents?limit=99999")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agents");
    expect(res.body.agents.length).toBeLessThanOrEqual(1000);
    expect(res.body.limit).toBe(1000);
  });

  it("GET /agents?limit=-5 falls back to the default (50)", async () => {
    const res = await request(app)
      .get("/api/agents?limit=-5")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.agents.length).toBeLessThanOrEqual(50);
  });

  it("GET /agents?limit=abc falls back to the default (50)", async () => {
    const res = await request(app)
      .get("/api/agents?limit=abc")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.agents.length).toBeLessThanOrEqual(50);
  });

  it("GET /agents?offset=-100 clamps offset to 0", async () => {
    const res = await request(app)
      .get("/api/agents?offset=-100&limit=10")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0);
  });
});

describe("Sanity: bulk-seeded data round-trips", () => {
  it("seeded the expected number of contacts", async () => {
    const rows = await handle.db.select().from(contactsTable);
    expect(rows.length).toBeGreaterThanOrEqual(SEED_CONTACT_COUNT);
  });

  it("seeded the expected number of agents", async () => {
    const rows = await handle.db.select().from(agentsTable);
    expect(rows.length).toBeGreaterThanOrEqual(SEED_AGENT_COUNT);
  });

  it("seeded a sizeable batch of audit_log entries (the cap test may reset and re-seed)", async () => {
    const rows = await handle.db.select().from(auditLogTable);
    // Either the original beforeAll seed or the per-test reseed keeps us
    // well above the heavy-list cap of 500.
    expect(rows.length).toBeGreaterThan(500);
  });
});
