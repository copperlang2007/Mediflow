/**
 * Cross-org write guard — defense-in-depth regression test.
 *
 * Every PATCH/DELETE handler in routes/ does a per-row existence check
 * scoped to the caller's org before issuing the write. The write itself
 * is now ALSO scoped to org at the query layer (see the matching PR),
 * so even if a future refactor weakens the existence check the WHERE
 * clause on the UPDATE/DELETE refuses to match a foreign-org row.
 *
 * This test asserts the handler-layer guarantee (404 on cross-org
 * access) which is the user-visible contract. The query-layer guarantee
 * is structural — verifiable by code search — and not exercised here
 * because the existence check stops the request before it reaches the
 * write.
 *
 * One representative site is picked from the changed set: DELETE
 * /sequences/:id. The same handler-level contract holds for every other
 * route in the sweep (templates, automations, retention flags,
 * pipelines, deals, contacts, agents, communications threads).
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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sequencesTable } from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
} from "../helpers/testApp";
import { seedOrg, seedUser, type TestDb } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  orgA = await seedOrg(testDb, { id: "cross-org-guard-a" });
  orgB = await seedOrg(testDb, { id: "cross-org-guard-b" });
  adminA = await seedUser(testDb, { orgId: orgA.id, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("Cross-org write guard (defense-in-depth)", () => {
  it("DELETE /sequences/:id from org A on a row owned by org B returns 404 and leaves the row intact", async () => {
    // Row lives in org B.
    const sequenceId = `seq-${randomUUID()}`;
    await testDb.insert(sequencesTable).values({
      id: sequenceId,
      orgId: orgB.id,
      name: "Org B sequence",
    });

    // Caller is in org A.
    const res = await request(app)
      .delete(`/api/sequences/${sequenceId}`)
      .set(withAuth(adminA.id));

    // Handler-layer existence check returns 404 — never reaches the DELETE.
    expect(res.status).toBe(404);

    // The row is still present (DELETE was not executed; even if it had
    // been, the query-layer org filter would have refused to match).
    const [stillThere] = await testDb
      .select({ id: sequencesTable.id, orgId: sequencesTable.orgId })
      .from(sequencesTable)
      .where(eq(sequencesTable.id, sequenceId))
      .limit(1);
    expect(stillThere?.id).toBe(sequenceId);
    expect(stillThere?.orgId).toBe(orgB.id);
  });

  it("PATCH /sequences/:id from org A on a row owned by org B returns 404 and leaves the row unchanged", async () => {
    const sequenceId = `seq-${randomUUID()}`;
    await testDb.insert(sequencesTable).values({
      id: sequenceId,
      orgId: orgB.id,
      name: "Org B sequence — original",
    });

    const res = await request(app)
      .patch(`/api/sequences/${sequenceId}`)
      .set(withAuth(adminA.id))
      .send({ name: "Hijacked by org A" });

    expect(res.status).toBe(404);

    const [row] = await testDb
      .select({ name: sequencesTable.name })
      .from(sequencesTable)
      .where(eq(sequencesTable.id, sequenceId))
      .limit(1);
    expect(row?.name).toBe("Org B sequence — original");
  });
});
