/**
 * End-to-end route tests for the onboarding API (Days 1-2 surface).
 *
 * Covers:
 *   - POST /onboarding/start: happy path, idempotency, auth, missing agent
 *   - GET /onboarding/:agentId: happy path, cross-org isolation
 *   - PATCH /onboarding/:agentId/profile: SSN encryption + masking by role,
 *     zod validation rejection, auto-advance status
 *   - POST /onboarding/:agentId/carriers/select: happy path, invalid carrier,
 *     re-select amends the existing row
 *   - POST /onboarding/:agentId/cancel: terminal transition, restart-after-cancel
 *   - GET /onboarding (admin list): role gating, status filter
 *   - 501 stub routes return 501 (regression guard so they don't ship empty)
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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  carriersTable,
  agentContractingProfilesTable,
  agentOnboardingRunsTable,
  carrierContractingRequestsTable,
} from "@workspace/db/schema";
import { decryptSsn, hashSsn } from "@workspace/db/encryption/pii";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let support: { id: string };
let viewerUser: { id: string };
let otherOrgAdmin: { id: string };
let agent: { id: string };
let agentB: { id: string };
let otherOrgAgent: { id: string };
let carrierA: { id: string };
let carrierB: { id: string };
let inactiveCarrier: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: "onb-org" });
  otherOrg = await seedOrg(handle.db, { id: "onb-other-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "super_admin" });
  support = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent_support",
  });
  viewerUser = await seedUser(handle.db, { orgId: org.id, role: "viewer" });
  otherOrgAdmin = await seedUser(handle.db, {
    orgId: otherOrg.id,
    role: "super_admin",
  });
  agent = await seedAgent(handle.db, { orgId: org.id });
  agentB = await seedAgent(handle.db, { orgId: org.id });
  otherOrgAgent = await seedAgent(handle.db, { orgId: otherOrg.id });

  // Carriers in our org
  carrierA = { id: `carrier-${randomUUID()}` };
  carrierB = { id: `carrier-${randomUUID()}` };
  inactiveCarrier = { id: `carrier-${randomUUID()}` };
  await handle.db.insert(carriersTable).values([
    { id: carrierA.id, orgId: org.id, name: "Acme Health" },
    { id: carrierB.id, orgId: org.id, name: "Best Care" },
    {
      id: inactiveCarrier.id,
      orgId: org.id,
      name: "Inactive Co",
      isActive: false,
    },
  ]);
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("POST /onboarding/start", () => {
  it("happy path: creates a draft run + empty profile", async () => {
    const res = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({ agentId: agent.id });
    expect(res.status).toBe(201);
    expect(res.body.run.status).toBe("draft");
    expect(res.body.run.agentId).toBe(agent.id);
    expect(res.body.profile).toBeTruthy();
    expect(res.body.profile.agentId).toBe(agent.id);
    expect(res.body.idempotent).toBe(false);
  });

  it("is idempotent on (org, agent): a second call returns the same run", async () => {
    const res = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({ agentId: agent.id });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.run.agentId).toBe(agent.id);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await request(app)
      .post("/api/onboarding/start")
      .send({ agentId: agent.id });
    expect(res.status).toBe(401);
  });

  it("rejects callers without agent:create permission (viewer)", async () => {
    const res = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(viewerUser.id))
      .send({ agentId: agent.id });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an agent that belongs to another org", async () => {
    const res = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({ agentId: otherOrgAgent.id });
    expect(res.status).toBe(404);
  });

  it("rejects an empty body via zod (no agentId)", async () => {
    const res = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid/);
  });
});

describe("GET /onboarding/:agentId", () => {
  it("returns the active run + masked profile for non-privileged role", async () => {
    const res = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(support.id));
    expect(res.status).toBe(200);
    expect(res.body.run.agentId).toBe(agent.id);
    expect(res.body.profile).toBeTruthy();
    expect(res.body.carrierRequests).toEqual([]);
  });

  it("rejects cross-org reads", async () => {
    const res = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(otherOrgAdmin.id));
    expect(res.status).toBe(404);
  });

  it("404s for an agent with no active onboarding", async () => {
    const res = await request(app)
      .get(`/api/onboarding/${agentB.id}`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /onboarding/:agentId/profile", () => {
  it("encrypts SSN before write — DB never has plaintext", async () => {
    const handle = await bootTestDb();
    const ssn = "987-65-4321";

    const res = await request(app)
      .patch(`/api/onboarding/${agent.id}/profile`)
      .set(withAuth(admin.id))
      .send({
        ssn,
        dob: "1972-03-15",
        homeAddressLine1: "1 Test Ln",
        homeCity: "Tampa",
        homeState: "FL",
        homeZip: "33602",
        entityType: "individual",
      });
    expect(res.status).toBe(200);
    // Privileged role: SSN returned formatted.
    expect(res.body.profile.ssn).toBe("987-65-4321");
    expect(res.body.profile.dob).toBe("1972-03-15");

    // DB shape check: the column is bytea ciphertext, not the plaintext.
    const [row] = await handle.db
      .select()
      .from(agentContractingProfilesTable)
      .where(
        and(
          eq(agentContractingProfilesTable.agentId, agent.id),
          eq(agentContractingProfilesTable.orgId, org.id),
        ),
      );
    expect(row.ssnEncrypted).toBeTruthy();
    const buf = row.ssnEncrypted!;
    // The bytea must NOT contain the plaintext digits anywhere.
    expect(buf.toString("utf8")).not.toContain("987654321");
    // Hash blind-index matches the normalized digits-only form.
    expect(Buffer.from(row.ssnHash as Buffer | Uint8Array).equals(hashSsn(ssn))).toBe(true);
    // Round-trip yields back the normalized plaintext.
    expect(decryptSsn(buf)).toBe("987654321");
  });

  it("masks SSN/DOB in API response for non-privileged role", async () => {
    const res = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(support.id));
    expect(res.status).toBe(200);
    expect(res.body.profile.ssn).toBe("***-**-****");
    expect(res.body.profile.dob).toBeNull();
  });

  it("rejects an SSN that is not exactly 9 digits (zod)", async () => {
    const res = await request(app)
      .patch(`/api/onboarding/${agent.id}/profile`)
      .set(withAuth(admin.id))
      .send({ ssn: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid/);
  });

  it("auto-advances the run from draft to profile_in_progress on first edit", async () => {
    // Use agentB which still has no run — start fresh and patch.
    const startRes = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({ agentId: agentB.id });
    expect(startRes.status).toBe(201);
    expect(startRes.body.run.status).toBe("draft");

    const patchRes = await request(app)
      .patch(`/api/onboarding/${agentB.id}/profile`)
      .set(withAuth(admin.id))
      .send({ phone: "+15551234567" });
    expect(patchRes.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/onboarding/${agentB.id}`)
      .set(withAuth(admin.id));
    expect(getRes.body.run.status).toBe("profile_in_progress");
  });

  it("cross-org PATCH attempt 404s", async () => {
    const res = await request(app)
      .patch(`/api/onboarding/${agent.id}/profile`)
      .set(withAuth(otherOrgAdmin.id))
      .send({ phone: "+1555" });
    expect(res.status).toBe(404);
  });
});

describe("POST /onboarding/:agentId/carriers/select", () => {
  it("happy path: creates draft contracting requests", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/select`)
      .set(withAuth(admin.id))
      .send({
        selections: [
          { carrierId: carrierA.id, states: ["FL", "GA"] },
          { carrierId: carrierB.id, states: ["FL"] },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.carrierRequests).toHaveLength(2);
    for (const cr of res.body.carrierRequests) {
      expect(cr.status).toBe("draft");
      expect(cr.agentId).toBe(agent.id);
      expect(cr.orgId).toBe(org.id);
    }
  });

  it("re-selecting the same carrier amends states on the existing row", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/select`)
      .set(withAuth(admin.id))
      .send({
        selections: [{ carrierId: carrierA.id, states: ["FL", "GA", "AL"] }],
      });
    expect(res.status).toBe(201);
    const handle = await bootTestDb();
    const rows = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.agentId, agent.id),
          eq(carrierContractingRequestsTable.carrierId, carrierA.id),
        ),
      );
    expect(rows).toHaveLength(1); // not 2 — the partial-unique held
    expect(rows[0].states).toEqual(["FL", "GA", "AL"]);
  });

  it("rejects an inactive carrier", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/select`)
      .set(withAuth(admin.id))
      .send({
        selections: [{ carrierId: inactiveCarrier.id, states: ["FL"] }],
      });
    expect(res.status).toBe(400);
    expect(res.body.invalidCarrierIds).toContain(inactiveCarrier.id);
  });

  it("rejects a carrier from another org", async () => {
    const handle = await bootTestDb();
    const xCarrierId = `carrier-${randomUUID()}`;
    await handle.db.insert(carriersTable).values({
      id: xCarrierId,
      orgId: otherOrg.id,
      name: "Other Org Carrier",
    });
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/select`)
      .set(withAuth(admin.id))
      .send({
        selections: [{ carrierId: xCarrierId, states: ["FL"] }],
      });
    expect(res.status).toBe(400);
    expect(res.body.invalidCarrierIds).toContain(xCarrierId);
  });

  it("rejects an empty selections array (zod)", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/select`)
      .set(withAuth(admin.id))
      .send({ selections: [] });
    expect(res.status).toBe(400);
  });

  it("rejects a state code that is not exactly 2 chars (zod)", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/select`)
      .set(withAuth(admin.id))
      .send({
        selections: [{ carrierId: carrierA.id, states: ["FLORIDA"] }],
      });
    expect(res.status).toBe(400);
  });
});

describe("POST /onboarding/:agentId/cancel", () => {
  it("cancels the active run and allows a fresh start", async () => {
    const cancelRes = await request(app)
      .post(`/api/onboarding/${agent.id}/cancel`)
      .set(withAuth(admin.id));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.run.status).toBe("cancelled");

    // After cancel, GET 404s because there is no active run.
    const getRes = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(admin.id));
    expect(getRes.status).toBe(404);

    // A fresh start succeeds (the partial-unique allows it).
    const restartRes = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({ agentId: agent.id });
    expect(restartRes.status).toBe(201);
    expect(restartRes.body.run.status).toBe("draft");
  });
});

describe("GET /onboarding (admin list)", () => {
  it("super_admin sees all runs in their org", async () => {
    const res = await request(app)
      .get("/api/onboarding")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
    // Cross-org isolation: every row belongs to caller's org.
    for (const row of res.body.data) {
      expect(row.orgId).toBe(org.id);
    }
  });

  it("agent_support is forbidden (admin-only endpoint)", async () => {
    const res = await request(app)
      .get("/api/onboarding")
      .set(withAuth(support.id));
    expect(res.status).toBe(403);
  });

  it("status filter narrows the result", async () => {
    const res = await request(app)
      .get("/api/onboarding?status=cancelled")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.status).toBe("cancelled");
    }
  });
});

describe("501 stubs for Days 5+ (regression guard)", () => {
  it("POST /onboarding/:agentId/signing/start returns 501", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/signing/start`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(501);
  });

  it("POST /onboarding/webhooks/esign returns 501", async () => {
    const res = await request(app).post("/api/onboarding/webhooks/esign").send({});
    expect(res.status).toBe(501);
  });

  it("POST /onboarding/:agentId/submit returns 501", async () => {
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/submit`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(501);
  });

  it("PATCH admin-status returns 501 (and is admin-only)", async () => {
    // First confirm admin-only is enforced (support → 403).
    const r1 = await request(app)
      .patch(`/api/onboarding/${agent.id}/carriers/some-req/admin-status`)
      .set(withAuth(support.id))
      .send({});
    expect(r1.status).toBe(403);

    // Then confirm admin reaches the 501.
    const r2 = await request(app)
      .patch(`/api/onboarding/${agent.id}/carriers/some-req/admin-status`)
      .set(withAuth(admin.id))
      .send({});
    expect(r2.status).toBe(501);
  });
});

