/**
 * Workspaces — super_admin agency provisioning (stage2/calendar-branding).
 *
 * Pins: only super_admin may list or create agencies; a new agency gets its
 * first admin through a real invitation (hashed token, agency_admin role, no
 * password anywhere); slugs are unique; the creation is audited in both the
 * operator's org and the new tenant; and the invitation is then acceptable
 * into the NEW org, not the operator's.
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
import {
  auditLogTable,
  organizationsTable,
  userInvitationsTable,
  usersTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedContact, seedOrg, seedUser, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let platformOrg: { id: string };
let superAdmin: { id: string };
let agencyAdmin: { id: string };

beforeAll(async () => {
  process.env.APP_BASE_URL = "https://app.example.test";
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest")).default;
  platformOrg = await seedOrg(testDb, { name: "Platform HQ", slug: `hq-${Date.now()}` });
  superAdmin = await seedUser(testDb, { orgId: platformOrg.id, role: "super_admin" });
  agencyAdmin = await seedUser(testDb, { orgId: platformOrg.id, role: "agency_admin", email: "taken@example.test" });
  await seedContact(testDb, { orgId: platformOrg.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("workspaces", () => {
  it("is super_admin only", async () => {
    const list = await request(app).get("/api/admin/agencies/overview").set(withAuth(agencyAdmin.id));
    expect(list.status).toBe(403);
    const create = await request(app)
      .post("/api/admin/agencies")
      .set(withAuth(agencyAdmin.id))
      .send({ name: "Sneaky", slug: "sneaky-agency", adminEmail: "a@b.test" });
    expect(create.status).toBe(403);
    expect((await request(app).post("/api/admin/agencies").send({})).status).toBe(401);
  });

  it("lists agencies with live counts", async () => {
    const res = await request(app).get("/api/admin/agencies/overview").set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    const hq = res.body.agencies.find((a: { id: string }) => a.id === platformOrg.id);
    expect(hq.users).toBe(2);
    expect(hq.clients).toBe(1);
    expect(hq.agents).toBe(0);
  });

  let newOrgId: string;
  let acceptUrl: string;

  it("creates an agency and invites its first admin", async () => {
    const res = await request(app)
      .post("/api/admin/agencies")
      .set(withAuth(superAdmin.id))
      .send({ name: "Cascade Senior Advisors", slug: "cascade-senior", adminEmail: "Dana@Cascade.test" });
    expect(res.status).toBe(201);
    newOrgId = res.body.agency.id;
    acceptUrl = res.body.acceptUrl;
    expect(res.body.agency.slug).toBe("cascade-senior");
    expect(res.body.invitation.role).toBe("agency_admin");
    expect(res.body.invitation.email).toBe("dana@cascade.test");
    expect(acceptUrl).toMatch(/^https:\/\/app\.example\.test\/accept-invite\?token=/);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    const [inv] = await testDb
      .select()
      .from(userInvitationsTable)
      .where(eq(userInvitationsTable.orgId, newOrgId));
    expect(inv.tokenHash).not.toContain(new URL(acceptUrl).searchParams.get("token")!);

    // The operator did not become a member of the new agency.
    const members = await testDb.select().from(usersTable).where(eq(usersTable.orgId, newOrgId));
    expect(members).toHaveLength(0);
  });

  it("audits the creation in the new tenant", async () => {
    const rows = await testDb
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.orgId, newOrgId), eq(auditLogTable.resourceType, "org")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].userId).toBe(superAdmin.id);
  });

  it("rejects a duplicate slug and an address that already has an account", async () => {
    const dupe = await request(app)
      .post("/api/admin/agencies")
      .set(withAuth(superAdmin.id))
      .send({ name: "Cascade Two", slug: "cascade-senior", adminEmail: "other@cascade.test" });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe("slug_taken");

    const taken = await request(app)
      .post("/api/admin/agencies")
      .set(withAuth(superAdmin.id))
      .send({ name: "Another", slug: "another-agency", adminEmail: "taken@example.test" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("email_taken");

    const [none] = await testDb
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, "another-agency"));
    expect(none).toBeUndefined();
  });

  it("validates slug format", async () => {
    const res = await request(app)
      .post("/api/admin/agencies")
      .set(withAuth(superAdmin.id))
      .send({ name: "Bad Slug", slug: "Bad Slug!", adminEmail: "x@y.test" });
    expect(res.status).toBe(400);
  });

  it("the invitation admits its accepter into the new agency as agency_admin", async () => {
    const token = new URL(acceptUrl).searchParams.get("token")!;
    const res = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth("clerk-dana"))
      .send({ token, fullName: "Dana Whitfield" });
    expect(res.status).toBe(201);
    expect(res.body.user.orgId).toBe(newOrgId);
    expect(res.body.user.role).toBe("agency_admin");
  });
});
