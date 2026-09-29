import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// vi.mock is hoisted above all imports. To keep the factory logic in a
// shared helper without tripping the hoist's TDZ, we reference the helper
// via vi.hoisted (which runs before the mocks register) and let each
// factory dynamically import it.
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

import { bootTestDb, shutdownTestDb, withAuth, withMfaAuth } from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  seedContact,
  truncateAuditLogForTests,
} from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let orgA: { id: string };
let orgB: { id: string };
let superAdmin: { id: string };
let agencyAdmin: { id: string };
let agentSupport: { id: string };
let viewerUser: { id: string };
let agentUser: { id: string };
let agentInOrgB: { id: string };
let contactInOrgA: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  orgA = await seedOrg(handle.db, { id: "org-a" });
  orgB = await seedOrg(handle.db, { id: "org-b" });

  superAdmin = await seedUser(handle.db, { orgId: orgA.id, role: "super_admin" });
  agencyAdmin = await seedUser(handle.db, { orgId: orgA.id, role: "agency_admin" });
  agentSupport = await seedUser(handle.db, { orgId: orgA.id, role: "agent_support" });
  viewerUser = await seedUser(handle.db, { orgId: orgA.id, role: "viewer" });
  agentUser = await seedUser(handle.db, { orgId: orgA.id, role: "agent" });

  // BOLA target: an agent that lives in a DIFFERENT org from the caller.
  agentInOrgB = await seedAgent(handle.db, { orgId: orgB.id });

  contactInOrgA = await seedContact(handle.db, { orgId: orgA.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("Auth & RBAC integration", () => {
  it("rejects unauthenticated GET /contacts with 401", async () => {
    const res = await request(app).get("/api/contacts");
    expect(res.status).toBe(401);
  });

  it("allows agent_support to GET /contacts", async () => {
    const res = await request(app)
      .get("/api/contacts")
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });

  it("allows viewer to GET /contacts (read permission includes viewer)", async () => {
    const res = await request(app)
      .get("/api/contacts")
      .set(withAuth(viewerUser.id));
    expect(res.status).toBe(200);
  });

  it("rejects pure 'agent' role on GET /contacts (not in matrix) with 403", async () => {
    const res = await request(app)
      .get("/api/contacts")
      .set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("rejects viewer POST /contacts with 403 (viewers cannot create)", async () => {
    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(viewerUser.id))
      .send({ firstName: "X", lastName: "Y" });
    expect(res.status).toBe(403);
  });

  it("rejects agent_support DELETE /contacts/:id with 403 (delete is admin-only)", async () => {
    const res = await request(app)
      .delete(`/api/contacts/${contactInOrgA.id}`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(403);
  });

  it("allows agency_admin DELETE /contacts/:id", async () => {
    const handle = await bootTestDb();
    const c = await seedContact(handle.db, { orgId: orgA.id });
    const res = await request(app)
      .delete(`/api/contacts/${c.id}`)
      .set(withAuth(agencyAdmin.id));
    expect(res.status).toBe(204);
  });

  it("rejects agent role on GET /admin/audit-log with 403", async () => {
    const res = await request(app)
      .get("/api/admin/audit-log")
      .set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("allows compliance_manager to GET /admin/audit-log", async () => {
    const handle = await bootTestDb();
    const cm = await seedUser(handle.db, {
      orgId: orgA.id,
      role: "compliance_manager",
    });
    // The admin route enriches entries with user fullnames via a `userId =
    // ANY($1)` query. Pglite's bound-parameter handling for JS arrays in
    // that exact SQL form differs from node-postgres in a way that is
    // tangential to RBAC. We empty audit_log first so the enrichment
    // path is short-circuited (length-zero guard) and this test only
    // exercises the role gate. audit_log is append-only (0002 blocks
    // UPDATE/DELETE, 0042 blocks TRUNCATE), so this goes through the
    // explicit test-only helper rather than a bare TRUNCATE.
    await truncateAuditLogForTests(handle);
    const res = await request(app)
      .get("/api/admin/audit-log")
      .set(withAuth(cm.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("entries");
  });

  it("returns 404 (not 200) when PATCH /agents/:id targets another org's agent (BOLA defense)", async () => {
    // superAdmin lives in orgA, agentInOrgB lives in orgB. Even with the
    // most-privileged role, the route MUST scope by req.orgId and return 404.
    const res = await request(app)
      .patch(`/api/agents/${agentInOrgB.id}`)
      .set(withAuth(superAdmin.id))
      .send({ firstName: "Cross-org leak" });
    expect(res.status).toBe(404);
  });

  it("allows super_admin to list agencies", async () => {
    const res = await request(app)
      .get("/api/admin/agencies")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.agencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: orgA.id }),
      expect.objectContaining({ id: orgB.id }),
    ]));
  });

  it("scopes super_admin reads to the selected agency", async () => {
    const contactInOrgB = await seedContact((await bootTestDb()).db, { orgId: orgB.id });
    const res = await request(app)
      .get("/api/contacts")
      .set(withAuth(superAdmin.id))
      .set("X-MediFlow-View-Org", orgB.id);
    expect(res.status).toBe(200);
    expect(res.body.data.some((contact: { id: string }) => contact.id === contactInOrgB.id)).toBe(true);
    expect(res.body.data.some((contact: { id: string }) => contact.id === contactInOrgA.id)).toBe(false);
    const { auditLogTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    await vi.waitFor(async () => {
      const rows = await (await bootTestDb()).db.select().from(auditLogTable).where(eq(auditLogTable.orgId, orgB.id));
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          userId: superAdmin.id,
          action: "read",
          changes: expect.objectContaining({
            viewOnly: true,
            realOrgId: orgA.id,
            viewingOrgId: orgB.id,
          }),
        }),
      ]));
    });
  });

  it("rejects all HTTP mutations while a super_admin is viewing an agency", async () => {
    const mutations = [
      { method: "post", path: "/api/contacts", body: { firstName: "Should", lastName: "NotCreate" } },
      { method: "patch", path: `/api/contacts/${contactInOrgA.id}`, body: { firstName: "ShouldNotEdit" } },
      { method: "put", path: "/api/org-settings", body: { ahipReminderEnabled: false } },
      { method: "delete", path: `/api/contacts/${contactInOrgA.id}`, body: undefined },
    ] as const;
    for (const { method, path, body } of mutations) {
      const call = request(app)[method](path)
        .set(withAuth(superAdmin.id))
        .set("X-MediFlow-View-Org", orgB.id);
      const res = await (body ? call.send(body) : call);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("VIEW_ONLY_MODE");
    }
  });
  it("allows an MFA-enrolled super admin to update a selected agency contact with an audited reason", async () => {
    const handle = await bootTestDb();
    const contact = await seedContact(handle.db, { orgId: orgB.id });
    const reason = "Agency requested correction to the contact profile";
    const res = await request(app)
      .patch(`/api/contacts/${contact.id}`)
      .set(withMfaAuth(superAdmin.id, true))
      .set("X-MediFlow-View-Org", orgB.id)
      .set("X-MediFlow-Support-Edit", "true")
      .set("X-MediFlow-Support-Reason", reason)
      .send({ firstName: "Corrected" });
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe("Corrected");
    const { auditLogTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    await vi.waitFor(async () => {
      const rows = await handle.db.select().from(auditLogTable).where(eq(auditLogTable.orgId, orgB.id));
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          userId: superAdmin.id,
          action: "update",
          changes: expect.objectContaining({
            supportEdit: true,
            supportReason: reason,
            realOrgId: orgA.id,
            viewingOrgId: orgB.id,
          }),
        }),
      ]));
    });
  });

  it("keeps cross-agency writes blocked without MFA, a reason, or an allowed path", async () => {
    const contact = await seedContact((await bootTestDb()).db, { orgId: orgB.id });
    const base = () => request(app).patch(`/api/contacts/${contact.id}`)
      .set("X-MediFlow-View-Org", orgB.id)
      .set("X-MediFlow-Support-Edit", "true")
      .send({ firstName: "Denied" });
    expect((await base().set(withMfaAuth(superAdmin.id, false))
      .set("X-MediFlow-Support-Reason", "Agency requested this correction")).body.code).toBe("SUPPORT_EDIT_REQUIREMENTS");
    expect((await base().set(withMfaAuth(superAdmin.id, true))).body.code).toBe("SUPPORT_EDIT_REQUIREMENTS");
    const forbidden = await request(app).delete(`/api/contacts/${contact.id}`)
      .set(withMfaAuth(superAdmin.id, true))
      .set("X-MediFlow-View-Org", orgB.id)
      .set("X-MediFlow-Support-Edit", "true")
      .set("X-MediFlow-Support-Reason", "Agency requested this correction");
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("VIEW_ONLY_MODE");
  });

  it("rejects view-as headers from non-super-admin users", async () => {
    const res = await request(app)
      .get("/api/contacts")
      .set(withAuth(agencyAdmin.id))
      .set("X-MediFlow-View-Org", orgB.id);
    expect(res.status).toBe(403);
  });
  it("rejects an inactive user with 401", async () => {
    const handle = await bootTestDb();
    const inactive = await seedUser(handle.db, {
      orgId: orgA.id,
      role: "agency_admin",
      isActive: false,
    });
    const res = await request(app)
      .get("/api/contacts")
      .set(withAuth(inactive.id));
    expect(res.status).toBe(401);
  });
});
