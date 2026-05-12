/**
 * MFA enforcement for privileged roles — HIPAA technical safeguard.
 *
 * requireMfa() returns 403 with body { error: "mfa_required" } when a
 * caller whose role is in MFA_REQUIRED_ROLES does not have an MFA factor
 * enrolled on their Clerk account. The middleware defaults to a NOP in
 * NODE_ENV=test so the rest of the suite doesn't have to know about MFA;
 * this test flips NODE_ENV for the duration of the file to exercise the
 * production code path end-to-end.
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";

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

import { bootTestDb, shutdownTestDb, withMfaAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let org: { id: string };
let adminNoMfa: { id: string };
let adminWithMfa: { id: string };
let agent: { id: string };

const originalNodeEnv = process.env.NODE_ENV;
const originalMfaRequired = process.env.MFA_REQUIRED;

beforeAll(async () => {
  // requireMfa NOPs in NODE_ENV=test (so unrelated suites don't break).
  // To actually exercise the enforcement path here we flip NODE_ENV out
  // of "test" and ensure MFA_REQUIRED is not "false".
  process.env.NODE_ENV = "production";
  process.env.MFA_REQUIRED = "true";

  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: "mfa-org" });
  adminNoMfa = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
  });
  adminWithMfa = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
  });
  agent = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent",
  });
});

afterAll(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalMfaRequired === undefined) {
    delete process.env.MFA_REQUIRED;
  } else {
    process.env.MFA_REQUIRED = originalMfaRequired;
  }
  await shutdownTestDb();
});

describe("MFA required for admin roles (HIPAA technical safeguard)", () => {
  it("403s POST /automations/rules for an agency_admin without MFA enrolled", async () => {
    const res = await request(app)
      .post("/api/automations/rules")
      .set(withMfaAuth(adminNoMfa.id, false))
      .send({
        name: "Test rule",
        triggerType: "lead_created",
        actions: [{ type: "create_task", config: {} }],
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "mfa_required" });
    expect(res.body.message).toMatch(/multi-factor/i);
  });

  it("allows GET /automations/rules for an agency_admin without MFA (reads not gated)", async () => {
    const res = await request(app)
      .get("/api/automations/rules")
      .set(withMfaAuth(adminNoMfa.id, false));

    // Read endpoints are intentionally not gated by MFA — verify we are
    // not 403'd. (200 OK with the empty list is the happy path.)
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it("allows POST /automations/rules for an agency_admin WITH MFA enrolled", async () => {
    const res = await request(app)
      .post("/api/automations/rules")
      .set(withMfaAuth(adminWithMfa.id, true))
      .send({
        name: "Real rule",
        triggerType: "lead_created",
        actions: [{ type: "create_task", config: { title: "Follow up" } }],
      });

    // 201 on success — but the important assertion is "not 403 mfa_required".
    expect(res.status).not.toBe(403);
    expect([200, 201]).toContain(res.status);
  });

  it("403s POST /automations/rules for an agent due to RBAC, not MFA (no masking)", async () => {
    // The pure 'agent' role is NOT in MFA_REQUIRED_ROLES, so requireMfa
    // is a no-op. The 403 must therefore come from the downstream RBAC
    // check (automation:create requires super_admin or agency_admin).
    // We assert the body shape distinguishes it from the MFA failure.
    const res = await request(app)
      .post("/api/automations/rules")
      .set(withMfaAuth(agent.id, false))
      .send({
        name: "Should be RBAC-blocked",
        triggerType: "lead_created",
        actions: [{ type: "create_task", config: {} }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe("mfa_required");
  });

  it("403s GET /admin/audit-log for agency_admin without MFA (entire admin router is MFA-gated)", async () => {
    const res = await request(app)
      .get("/api/admin/audit-log")
      .set(withMfaAuth(adminNoMfa.id, false));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "mfa_required" });
  });

  it("does not block GET /commission-schedules for an admin without MFA (read-only is ungated)", async () => {
    const res = await request(app)
      .get("/api/commission-schedules")
      .set(withMfaAuth(adminNoMfa.id, false));
    expect(res.status).not.toBe(403);
  });

  it("respects MFA_REQUIRED=false override (local dev escape hatch)", async () => {
    process.env.MFA_REQUIRED = "false";
    try {
      const res = await request(app)
        .post("/api/automations/rules")
        .set(withMfaAuth(adminNoMfa.id, false))
        .send({
          name: "Override-allowed rule",
          triggerType: "lead_created",
          actions: [{ type: "create_task", config: {} }],
        });
      // With MFA enforcement disabled, no-MFA admin can write. Either a
      // create (201) or a downstream validation error — but never 403
      // mfa_required.
      expect(res.body.error).not.toBe("mfa_required");
    } finally {
      process.env.MFA_REQUIRED = "true";
    }
  });
});
