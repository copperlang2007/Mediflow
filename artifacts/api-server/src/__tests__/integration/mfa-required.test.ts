/**
 * Mandatory MFA for every user — HIPAA technical safeguard.
 *
 * requireAuth (and requireMfa on the most sensitive routes) returns 403 with
 * body { error: "mfa_required" } when the caller, whatever their role, has no
 * MFA factor enrolled on their Clerk account. The middleware defaults to a NOP in
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

import { bootTestDb, shutdownTestDb, withMfaAuth, clerkTwoFactorByUser } from "../helpers/testApp";
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

describe("MFA required for every user (HIPAA technical safeguard)", () => {
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

  it("accepts the Clerk template claim when it arrives as the string \"true\"", async () => {
    const res = await request(app)
      .post("/api/automations/rules")
      .set({ ...withMfaAuth(adminWithMfa.id, true), "x-test-mfa-enrolled": "as-string" })
      .send({ name: "String-claim rule", triggerType: "lead_created", actions: [{ type: "create_task", config: { title: "x" } }] });
    expect(res.body.error).not.toBe("mfa_required");
  });

  it("ignores MFA_REQUIRED=false in production: MFA is still enforced", async () => {
    process.env.MFA_REQUIRED = "false";
    try {
      const res = await request(app)
        .post("/api/automations/rules")
        .set(withMfaAuth(adminNoMfa.id, false))
        .send({ name: "Bypass attempt", triggerType: "lead_created", actions: [{ type: "create_task", config: {} }] });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "mfa_required" });
    } finally {
      process.env.MFA_REQUIRED = "true";
    }
  });

  it("ignores MFA_REQUIRED=false for a super admin viewing another agency in production", async () => {
    const { db } = await bootTestDb();
    const other = await seedOrg(db, { id: "mfa-org-other" });
    const superNoMfa = await seedUser(db, { orgId: org.id, role: "super_admin" });
    const previousMfaRequired = process.env.MFA_REQUIRED;
    process.env.MFA_REQUIRED = "false";
    try {
      const denied = await request(app)
        .get("/api/contacts")
        .set(withMfaAuth(superNoMfa.id, false))
        .set("X-MediFlow-View-Org", other.id);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ error: "mfa_required" });
      const allowed = await request(app)
        .get("/api/contacts")
        .set(withMfaAuth(superNoMfa.id, true))
        .set("X-MediFlow-View-Org", other.id);
      expect(allowed.status).toBe(200);
    } finally {
      if (previousMfaRequired === undefined) {
        delete process.env.MFA_REQUIRED;
      } else {
        process.env.MFA_REQUIRED = previousMfaRequired;
      }
    }
  });

  it("still lets local development switch MFA off", async () => {
    const { mfaEnforced } = await import("../../middlewares/requireMfa");
    process.env.NODE_ENV = "development";
    process.env.MFA_REQUIRED = "false";
    try {
      expect(mfaEnforced()).toBe(false);
    } finally {
      process.env.NODE_ENV = "production";
      process.env.MFA_REQUIRED = "true";
    }
  });

  it("403s reads too: GET /automations/rules for an agency_admin without MFA", async () => {
    const res = await request(app)
      .get("/api/automations/rules")
      .set(withMfaAuth(adminNoMfa.id, false));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "mfa_required", code: "MFA_REQUIRED" });
  });

  it("403s an agent without MFA on their own routes", async () => {
    const res = await request(app)
      .get("/api/agents/me/clients")
      .set(withMfaAuth(agent.id, false));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "mfa_required" });
  });

  it("lets an agent with MFA through to the route", async () => {
    const res = await request(app)
      .get("/api/automations/rules")
      .set(withMfaAuth(agent.id, true));
    expect(res.body.error).not.toBe("mfa_required");
  });

  it("falls back to Clerk's API when the session token has no MFA claim (template missing)", async () => {
    const { db } = await bootTestDb();
    const enrolled = await seedUser(db, { orgId: org.id, role: "agent" });
    const notEnrolled = await seedUser(db, { orgId: org.id, role: "agent" });
    clerkTwoFactorByUser.set(enrolled.id, true);
    clerkTwoFactorByUser.set(notEnrolled.id, false);
    const absent = (id: string) => ({ ...withMfaAuth(id, false), "x-test-mfa-enrolled": "absent" });

    const ok = await request(app).get("/api/agents/me/clients").set(absent(enrolled.id));
    expect(ok.body.error).not.toBe("mfa_required");
    const status = await request(app).get("/api/auth/status").set(absent(enrolled.id));
    expect(status.body).toMatchObject({ mfaEnrolled: true });

    const denied = await request(app).get("/api/agents/me/clients").set(absent(notEnrolled.id));
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "mfa_required" });
  });

  it("does not consult Clerk when the claim is present and false", async () => {
    const { db } = await bootTestDb();
    const u = await seedUser(db, { orgId: org.id, role: "agent" });
    clerkTwoFactorByUser.set(u.id, true);
    const res = await request(app).get("/api/agents/me/clients").set(withMfaAuth(u.id, false));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "mfa_required" });
  });

  it("reports MFA state on /auth/status, which stays reachable without MFA", async () => {
    const without = await request(app).get("/api/auth/status").set(withMfaAuth(agent.id, false));
    expect(without.status).toBe(200);
    expect(without.body).toMatchObject({ provisioned: true, mfaRequired: true, mfaEnrolled: false });
    const withMfa = await request(app).get("/api/auth/status").set(withMfaAuth(agent.id, true));
    expect(withMfa.body).toMatchObject({ mfaRequired: true, mfaEnrolled: true });
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

  it("403s POST /automations/rules for an agent with MFA due to RBAC, not MFA (no masking)", async () => {
    // With MFA enrolled the gate passes, so the 403 must come from the
    // downstream RBAC check (automation:create requires an admin role).
    // We assert the body shape distinguishes it from the MFA failure.
    const res = await request(app)
      .post("/api/automations/rules")
      .set(withMfaAuth(agent.id, true))
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

  it("respects MFA_REQUIRED=false override outside production (local dev escape hatch)", async () => {
    process.env.NODE_ENV = "development";
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
      process.env.NODE_ENV = "production";
      process.env.MFA_REQUIRED = "true";
    }
  });
});
