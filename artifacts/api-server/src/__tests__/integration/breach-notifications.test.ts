/**
 * Integration test: HIPAA breach-notifications CRUD + RBAC.
 *
 * Covers the routes added in PR #36 under `/admin/breach-notifications`:
 *  - POST  (create) — restricted to super_admin / compliance_manager
 *  - GET   (list)   — scoped to caller's org
 *  - GET   (:id)    — also scoped, returns 404 cross-org (BOLA defense)
 *  - PATCH (:id)    — status transitions; resolved status sets resolvedAt /
 *                     resolvedByUserId
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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import { breachNotificationsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;

let orgA: { id: string };
let orgB: { id: string };
let superAdmin: { id: string };
let complianceManager: { id: string };
let agentUser: { id: string };
let orgBSuperAdmin: { id: string };

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  orgA = await seedOrg(handle.db, { id: "breach-org-a" });
  orgB = await seedOrg(handle.db, { id: "breach-org-b" });

  superAdmin = await seedUser(handle.db, { orgId: orgA.id, role: "super_admin" });
  complianceManager = await seedUser(handle.db, {
    orgId: orgA.id,
    role: "compliance_manager",
  });
  agentUser = await seedUser(handle.db, { orgId: orgA.id, role: "agent" });
  orgBSuperAdmin = await seedUser(handle.db, {
    orgId: orgB.id,
    role: "super_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("Breach notifications CRUD + RBAC", () => {
  let createdId: string;

  it("POST /admin/breach-notifications as super_admin → 201 + persists row", async () => {
    const res = await request(app)
      .post("/api/admin/breach-notifications")
      .set(withAuth(superAdmin.id))
      .send({
        severity: "high",
        affectedRecordType: "contact",
        affectedRecordCount: 5,
        description: "Suspicious export of contact PHI",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      severity: "high",
      affectedRecordType: "contact",
      affectedRecordCount: 5,
      status: "open",
      orgId: orgA.id,
    });
    expect(res.body.id).toBeTruthy();
    createdId = res.body.id;

    const rows = await handle.db
      .select()
      .from(breachNotificationsTable)
      .where(eq(breachNotificationsTable.id, createdId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detectedByUserId).toBe(superAdmin.id);
  });

  it("POST /admin/breach-notifications as agent → 403", async () => {
    const res = await request(app)
      .post("/api/admin/breach-notifications")
      .set(withAuth(agentUser.id))
      .send({
        severity: "low",
        affectedRecordType: "contact",
        affectedRecordCount: 1,
        description: "should be rejected",
      });
    expect(res.status).toBe(403);
  });

  it("GET /admin/breach-notifications as compliance_manager → returns own org's rows only", async () => {
    // Insert a row directly into orgB so we can assert it does NOT leak into orgA's list.
    await handle.db.insert(breachNotificationsTable).values({
      id: "breach-orgb-leak-canary",
      orgId: orgB.id,
      detectedBySystem: "manual",
      affectedRecordType: "contact",
      affectedRecordCount: 99,
      description: "orgB-only canary",
      severity: "low",
      status: "open",
      notificationRequired: false,
    });

    const res = await request(app)
      .get("/api/admin/breach-notifications")
      .set(withAuth(complianceManager.id));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    const ids = (res.body.entries as Array<{ id: string; orgId: string }>).map(
      (e) => e.id,
    );
    expect(ids).toContain(createdId);
    expect(ids).not.toContain("breach-orgb-leak-canary");
    for (const e of res.body.entries) {
      expect(e.orgId).toBe(orgA.id);
    }
  });

  it("PATCH /admin/breach-notifications/:id status='investigating' → 200 + row updated", async () => {
    const res = await request(app)
      .patch(`/api/admin/breach-notifications/${createdId}`)
      .set(withAuth(complianceManager.id))
      .send({ status: "investigating" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("investigating");

    const [row] = await handle.db
      .select()
      .from(breachNotificationsTable)
      .where(eq(breachNotificationsTable.id, createdId));
    expect(row?.status).toBe("investigating");
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedByUserId).toBeNull();
  });

  it("PATCH status='resolved' → also sets resolvedAt + resolvedByUserId", async () => {
    const res = await request(app)
      .patch(`/api/admin/breach-notifications/${createdId}`)
      .set(withAuth(superAdmin.id))
      .send({
        status: "resolved",
        resolutionNotes: "Confirmed false alarm; no PHI left the system.",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");

    const [row] = await handle.db
      .select()
      .from(breachNotificationsTable)
      .where(eq(breachNotificationsTable.id, createdId));
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedAt).toBeInstanceOf(Date);
    expect(row?.resolvedByUserId).toBe(superAdmin.id);
    expect(row?.resolutionNotes).toMatch(/false alarm/i);
  });

  it("GET /admin/breach-notifications/:id as agent → 403", async () => {
    const res = await request(app)
      .get(`/api/admin/breach-notifications/${createdId}`)
      .set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("GET /admin/breach-notifications/:id cross-org → 404 (BOLA defense)", async () => {
    // orgBSuperAdmin is a super_admin in orgB; attempting to fetch a breach
    // record that lives in orgA must return 404, not 200.
    const res = await request(app)
      .get(`/api/admin/breach-notifications/${createdId}`)
      .set(withAuth(orgBSuperAdmin.id));
    expect(res.status).toBe(404);
  });
});
