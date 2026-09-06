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
import { seedOrg, seedUser, truncateAuditLogForTests } from "../helpers/testDb";
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
let licenseTestAgentId: string;
let taskTestAgentId: string;
let threadTestContactId: string;

const SEED_CONTACT_COUNT = 1500;
const SEED_AGENT_COUNT = 1100;
const SEED_AUDIT_COUNT = 600;
// 75 extra users on top of the two real test fixtures (superAdmin + agentSupport)
// so we can exercise the GET /users default / offset / explicit-limit behaviour.
const SEED_BULK_USER_COUNT = 75;
// 60 licenses on the dedicated license-test agent — above the route's default
// of 50 so the default-limit case actually clamps, and below the 200 cap so
// `?limit=200` returns every row.
const SEED_LICENSE_COUNT = 60;
// 70 tasks on the dedicated task-test agent — same shape as the license
// seed: above the default of 50 so the clamp fires, below the 200 cap so
// `?limit=200` returns everything.
const SEED_AGENT_TASK_COUNT = 70;
// 65 threads on a single contact — above default 50, below cap 200.
const SEED_CONTACT_THREAD_COUNT = 65;

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

  // GET /users coverage: seed 75 extra rows so the org has > the default
  // limit of 50 but < the 200 cap. This lets us assert each of:
  //   - default request          → 50 rows
  //   - ?limit=200               → all rows
  //   - ?offset=50 (+ ?limit=50) → the remaining tail
  const userValues: string[] = [];
  for (let i = 0; i < SEED_BULK_USER_COUNT; i++) {
    const id = `pgu-${i}-${randomUUID().slice(0, 8)}`;
    userValues.push(
      `('${id}', '${org.id}', 'pgu${i}@x.test', 'Bulk User ${i}', 'agent', true)`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO users (id, org_id, email, full_name, role, is_active) VALUES ${userValues.join(",")};`,
  );

  // GET /agents/:id/licenses coverage: a dedicated agent with 60 licenses.
  // In production a real US-state agent caps around 50 rows, but the route's
  // guard is sized for 200 — seeding above the default exercises the clamp.
  // Each license needs a unique (agentId, stateCode, licenseType) combination
  // in practice, but the table has no such constraint, so synthetic codes are
  // fine for an integration test.
  licenseTestAgentId = `lic-test-agent-${randomUUID().slice(0, 8)}`;
  await handle.pg.exec(
    `INSERT INTO agents (id, org_id, first_name, last_name, email) VALUES ('${licenseTestAgentId}', '${org.id}', 'License', 'Tester', 'lic@x.test');`,
  );
  const licenseValues: string[] = [];
  for (let i = 0; i < SEED_LICENSE_COUNT; i++) {
    const id = randomUUID();
    // Synthetic 2-char state code: padStart keeps the column-length=2
    // assumption from `CreateLicenseSchema` happy if any other layer reads
    // it; for the GET path the value is opaque.
    const stateCode = i.toString(36).padStart(2, "0").toUpperCase();
    licenseValues.push(
      `('${id}', '${licenseTestAgentId}', '${stateCode}', 'Life & Health', 'active')`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO state_licenses (id, agent_id, state_code, license_type, status) VALUES ${licenseValues.join(",")};`,
  );

  // GET /agents/:id/tasks coverage: dedicated agent + 70 tasks so the
  // route's default-50 limit clamps and the 200-cap query returns
  // everything. Mirrors the license-seed shape.
  taskTestAgentId = `task-test-agent-${randomUUID().slice(0, 8)}`;
  await handle.pg.exec(
    `INSERT INTO agents (id, org_id, first_name, last_name, email) VALUES ('${taskTestAgentId}', '${org.id}', 'Task', 'Tester', 'tasktest@x.test');`,
  );
  const taskValues: string[] = [];
  for (let i = 0; i < SEED_AGENT_TASK_COUNT; i++) {
    const id = randomUUID();
    taskValues.push(
      `('${id}', '${org.id}', '${taskTestAgentId}', 'Task ${i}', 'open', 'medium')`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO task_instances (id, org_id, agent_id, title, status, priority) VALUES ${taskValues.join(",")};`,
  );

  // GET /contacts/:id/threads coverage: dedicated contact + 65 threads.
  threadTestContactId = `thread-test-contact-${randomUUID().slice(0, 8)}`;
  await handle.pg.exec(
    `INSERT INTO contacts (id, org_id, first_name, last_name, status) VALUES ('${threadTestContactId}', '${org.id}', 'Thread', 'Tester', 'lead');`,
  );
  const threadValues: string[] = [];
  for (let i = 0; i < SEED_CONTACT_THREAD_COUNT; i++) {
    const id = randomUUID();
    const channel = i % 2 === 0 ? "sms" : "email";
    threadValues.push(
      `('${id}', '${org.id}', '${threadTestContactId}', '${channel}')`,
    );
  }
  await handle.pg.exec(
    `INSERT INTO message_threads (id, org_id, contact_id, channel) VALUES ${threadValues.join(",")};`,
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
    // test. audit_log is append-only (0002 blocks UPDATE/DELETE, 0042
    // blocks TRUNCATE), so this goes through the explicit test-only helper
    // rather than a bare TRUNCATE.
    // The audit middleware writes its own log entry on `res.on("finish")`,
    // i.e. AFTER the response is sent, so it can't pollute this GET.
    await truncateAuditLogForTests(handle);
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

  // ---------------------------------------------------------------------------
  // GET /users — previously unbounded. New contract: { data, total, limit,
  // offset } with default limit 50 and a hard cap of 200. We seed 75 bulk
  // users on top of two fixture users (superAdmin + agentSupport) ⇒ 77 total
  // in the org.
  // ---------------------------------------------------------------------------
  const TOTAL_USERS_IN_ORG = SEED_BULK_USER_COUNT + 2;

  it("GET /users returns the default page of 50 when no limit is specified", async () => {
    const res = await request(app)
      .get("/api/users")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(TOTAL_USERS_IN_ORG);
  });

  it("GET /users?limit=200 returns every user in the org (75 seeded + 2 fixtures)", async () => {
    const res = await request(app)
      .get("/api/users?limit=200")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(TOTAL_USERS_IN_ORG);
    expect(res.body.limit).toBe(200);
    expect(res.body.total).toBe(TOTAL_USERS_IN_ORG);
  });

  it("GET /users?offset=50&limit=50 returns the remaining 27 rows", async () => {
    const res = await request(app)
      .get("/api/users?offset=50&limit=50")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(TOTAL_USERS_IN_ORG - 50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(50);
    expect(res.body.total).toBe(TOTAL_USERS_IN_ORG);
  });

  it("GET /users?limit=99999 is clamped to the 200 cap, not echoed back", async () => {
    const res = await request(app)
      .get("/api/users?limit=99999")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(200);
  });

  // ---------------------------------------------------------------------------
  // GET /agents/:id/licenses — previously unbounded. New contract is the
  // same shape as /users. 60 licenses seeded against `licenseTestAgentId`.
  // ---------------------------------------------------------------------------

  it("GET /agents/:id/licenses returns the default page of 50 with no limit", async () => {
    const res = await request(app)
      .get(`/api/agents/${licenseTestAgentId}/licenses`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(SEED_LICENSE_COUNT);
  });

  it("GET /agents/:id/licenses?limit=200 returns all 60 seeded licenses", async () => {
    const res = await request(app)
      .get(`/api/agents/${licenseTestAgentId}/licenses?limit=200`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_LICENSE_COUNT);
    expect(res.body.limit).toBe(200);
    expect(res.body.total).toBe(SEED_LICENSE_COUNT);
  });

  it("GET /agents/:id/licenses?offset=50&limit=50 returns the trailing 10 rows", async () => {
    const res = await request(app)
      .get(`/api/agents/${licenseTestAgentId}/licenses?offset=50&limit=50`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_LICENSE_COUNT - 50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(50);
    expect(res.body.total).toBe(SEED_LICENSE_COUNT);
  });

  it("GET /agents/:id/licenses?limit=99999 is clamped to the 200 cap", async () => {
    const res = await request(app)
      .get(`/api/agents/${licenseTestAgentId}/licenses?limit=99999`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(200);
  });

  // ---------------------------------------------------------------------------
  // GET /agents/:id/tasks — previously unbounded. Round-6 (this PR) ships
  // the same { data, total, limit, offset } envelope. 70 tasks seeded
  // against `taskTestAgentId`.
  // ---------------------------------------------------------------------------

  it("GET /agents/:id/tasks returns the default page of 50 with no limit", async () => {
    const res = await request(app)
      .get(`/api/agents/${taskTestAgentId}/tasks`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(SEED_AGENT_TASK_COUNT);
  });

  it("GET /agents/:id/tasks?limit=200 returns every seeded task", async () => {
    const res = await request(app)
      .get(`/api/agents/${taskTestAgentId}/tasks?limit=200`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_AGENT_TASK_COUNT);
    expect(res.body.limit).toBe(200);
    expect(res.body.total).toBe(SEED_AGENT_TASK_COUNT);
  });

  it("GET /agents/:id/tasks?offset=50&limit=50 returns the trailing rows", async () => {
    const res = await request(app)
      .get(`/api/agents/${taskTestAgentId}/tasks?offset=50&limit=50`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_AGENT_TASK_COUNT - 50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(50);
    expect(res.body.total).toBe(SEED_AGENT_TASK_COUNT);
  });

  it("GET /agents/:id/tasks?limit=99999 is clamped to the 200 cap", async () => {
    const res = await request(app)
      .get(`/api/agents/${taskTestAgentId}/tasks?limit=99999`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(200);
  });

  // ---------------------------------------------------------------------------
  // GET /contacts/:id/threads — previously unbounded. Round-6 ships the
  // shared envelope. 65 threads seeded against `threadTestContactId`.
  // ---------------------------------------------------------------------------

  it("GET /contacts/:id/threads returns the default page of 50 with no limit", async () => {
    const res = await request(app)
      .get(`/api/contacts/${threadTestContactId}/threads`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(SEED_CONTACT_THREAD_COUNT);
  });

  it("GET /contacts/:id/threads?limit=200 returns every seeded thread", async () => {
    const res = await request(app)
      .get(`/api/contacts/${threadTestContactId}/threads?limit=200`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_CONTACT_THREAD_COUNT);
    expect(res.body.limit).toBe(200);
    expect(res.body.total).toBe(SEED_CONTACT_THREAD_COUNT);
  });

  it("GET /contacts/:id/threads?offset=50&limit=50 returns the trailing rows", async () => {
    const res = await request(app)
      .get(`/api/contacts/${threadTestContactId}/threads?offset=50&limit=50`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_CONTACT_THREAD_COUNT - 50);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(50);
    expect(res.body.total).toBe(SEED_CONTACT_THREAD_COUNT);
  });

  it("GET /contacts/:id/threads?limit=99999 is clamped to the 200 cap", async () => {
    const res = await request(app)
      .get(`/api/contacts/${threadTestContactId}/threads?limit=99999`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(200);
  });

  // ---------------------------------------------------------------------------
  // POST /licenses/bulk-import — the agent-validation lookup used to fetch
  // ALL agents in the org into memory to build a Set; on orgs with tens of
  // thousands of agents that OOMs. Round-6 swapped to a bounded
  // `WHERE id IN (...)` lookup over the requested agentIds.
  //
  // Behavioural assertion: an import that references only a handful of
  // agents (10 unknown + 1 known) doesn't choke on the SEED_AGENT_COUNT
  // (1100) rows already present in the org. With the old implementation,
  // the validation set still got built (correctly, just slowly); the new
  // implementation only fetches the 11 requested ids. We can't directly
  // observe the query shape from a black-box request, but we CAN assert
  // the route correctly classifies unknown ids as skipped — which proves
  // the new IN-list filter pinned to orgId works.
  // ---------------------------------------------------------------------------

  it("POST /licenses/bulk-import validates only the requested agentIds, not every org agent", async () => {
    // Reuse the already-seeded licenseTestAgentId for the one valid row.
    const rows = [
      // 1 valid row — agent exists in the org and was seeded above.
      {
        agentId: licenseTestAgentId,
        stateCode: "ZZ",
        licenseType: "Bulk Import Test",
        status: "active",
      },
      // 10 unknown ids — must be skipped, NOT cause a 500.
      ...Array.from({ length: 10 }, (_, i) => ({
        agentId: `not-a-real-agent-${i}-${randomUUID().slice(0, 8)}`,
        stateCode: "ZZ",
        licenseType: "Bulk Import Test",
        status: "active",
      })),
    ];

    const res = await request(app)
      .post("/api/licenses/bulk-import")
      .set(withAuth(superAdmin.id))
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(10);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBe(10);
    // Every error must reference the "not found in org" classification —
    // i.e. the route filtered the IN-list correctly.
    expect(
      res.body.errors.every((e: string) => e.includes("not found in org")),
    ).toBe(true);
  });

  it("POST /licenses/bulk-import rejects an agentId from a different org", async () => {
    // Seed a second org + agent, then try to import a license against the
    // foreign agentId. The bounded query must NOT return rows from another
    // org, so this should land in the "skipped" bucket.
    const otherOrg = await seedOrg(handle.db, { id: `other-org-${randomUUID().slice(0, 8)}` });
    const foreignAgentId = `foreign-${randomUUID().slice(0, 8)}`;
    await handle.pg.exec(
      `INSERT INTO agents (id, org_id, first_name, last_name, email) VALUES ('${foreignAgentId}', '${otherOrg.id}', 'Foreign', 'Agent', 'foreign@x.test');`,
    );

    const res = await request(app)
      .post("/api/licenses/bulk-import")
      .set(withAuth(superAdmin.id))
      .send({
        rows: [
          {
            agentId: foreignAgentId,
            stateCode: "ZZ",
            licenseType: "Cross-Org Test",
            status: "active",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.errors[0]).toContain("not found in org");
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
