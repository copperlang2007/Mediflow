/**
 * "My clients": an agent sees only the clients they service (assigned, or a
 * policy they wrote), with PHI, and opens those clients' full applications
 * (audited); never another agent's clients.
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

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import {
  agentsTable,
  auditLogTable,
  contactsTable,
  enrollmentsTable,
  enrollmentApplicationsTable,
  enrollmentApplicationVersionsTable,
} from "@workspace/db/schema";
import { encryptPii } from "@workspace/db/encryption/pii";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedAgent, seedUser, seedContact, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let tdb: TestDb;
let org: { id: string };
let userA: { id: string };
let userB: { id: string };
let admin: { id: string };
let mine: { id: string };
let wroteForOther: { id: string };
let notMine: { id: string };
let appWritten: string;
let appNotMine: string;
let ended: { id: string };
let appEnded: string;
let appAmbiguous: string;
let appFallback: string;
let supportUser: { id: string };

async function seedApplication(contactId: string, enrollmentId: string | null, fields: Record<string, string>): Promise<string> {
  const id = randomUUID();
  await tdb.insert(enrollmentApplicationsTable).values({
    id, orgId: org.id, source: "gohighlevel", applicationKey: `key-${id}`, contactId, enrollmentId,
    planName: "Humana Gold Plus", carrierName: "Humana", currentVersion: 1,
  });
  const { encrypted, hash } = encryptPii(JSON.stringify({ source: "gohighlevel", ghlContactId: "g1", fields }));
  await tdb.insert(enrollmentApplicationVersionsTable).values({
    id: randomUUID(), applicationId: id, version: 1, eventType: "GHL_SUNFIRE_APPLICATION", payloadEncrypted: encrypted, payloadHmac: hash,
  });
  return id;
}

async function seedEnrollment(contactId: string, agentId: string, status: "pending" | "cancelled" = "pending"): Promise<string> {
  const id = randomUUID();
  await tdb.insert(enrollmentsTable).values({
    id, orgId: org.id, contactId, agentId, planType: "MA", planYear: 2027, effectiveDate: "2027-01-01", planName: "Humana Gold Plus", status,
  });
  return id;
}

beforeAll(async () => {
  const handle = await bootTestDb();
  tdb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  org = await seedOrg(tdb, { id: "agent-clients-org" });
  admin = await seedUser(tdb, { orgId: org.id, role: "agency_admin" });
  userA = await seedUser(tdb, { orgId: org.id, role: "agent" });
  userB = await seedUser(tdb, { orgId: org.id, role: "agent" });
  const agentA = await seedAgent(tdb, { orgId: org.id });
  const agentB = await seedAgent(tdb, { orgId: org.id });
  await tdb.update(agentsTable).set({ userId: userA.id }).where(eq(agentsTable.id, agentA.id));
  await tdb.update(agentsTable).set({ userId: userB.id }).where(eq(agentsTable.id, agentB.id));

  mine = await seedContact(tdb, {
    orgId: org.id, firstName: "Rosa", lastName: "Alvarez", medicareId: "1EG4TE5MK73",
    dob: new Date("1951-03-07T00:00:00Z"), healthConditions: ["COPD", "Diabetes"],
  });
  wroteForOther = await seedContact(tdb, { orgId: org.id, firstName: "Carmen", lastName: "Ortiz", medicareId: "4CD5EF6GH78", healthConditions: ["CHF"], dob: new Date("1955-08-15T00:00:00Z") });
  ended = await seedContact(tdb, { orgId: org.id, firstName: "Ellen", lastName: "Price", medicareId: "5DE6FG7HJ89" });
  notMine = await seedContact(tdb, { orgId: org.id, firstName: "Dana", lastName: "Stone", medicareId: "2AB3CD4EF56" });
  await tdb.update(contactsTable).set({ assignedAgentId: agentA.id }).where(eq(contactsTable.id, mine.id));
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, wroteForOther.id));
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, notMine.id));
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, ended.id));

  const written = await seedEnrollment(wroteForOther.id, agentA.id);
  appWritten = await seedApplication(wroteForOther.id, written, { "Medicare Number (medicare_number)": "3CD4EF5GH67", "Has COPD (has_copd)": "Yes" });
  const theirs = await seedEnrollment(notMine.id, agentB.id);
  appNotMine = await seedApplication(notMine.id, theirs, { "Medicare Number (medicare_number)": "2AB3CD4EF56" });
  // A policy agent A wrote that has since been cancelled: no longer theirs to service.
  const cancelled = await seedEnrollment(ended.id, agentA.id, "cancelled");
  appEnded = await seedApplication(ended.id, cancelled, { "Medicare Number (medicare_number)": "5DE6FG7HJ89" });
  appAmbiguous = await seedApplication(mine.id, null, {
    "Spouse Medicare Number (medicare_number)": "9SP1OU2SE34",
    "Medicare Number (medicare_number)": "1EG4TE5MK73",
  });
  appFallback = await seedApplication(mine.id, null, {
    "Spouse Medicare Number (medicare_number)": "9SP1OU2SE34",
    "Medicare Number (medicare_number)": "1EG4TE5MK73",
    "Applicant HICN (applicanthicn)": "7HJ2CK3AB45",
  });
  // A back-office user who happens to have a linked agent row gains nothing from it.
  supportUser = await seedUser(tdb, { orgId: org.id, role: "agent_support" });
  const supportAgent = await seedAgent(tdb, { orgId: org.id });
  await tdb.update(agentsTable).set({ userId: supportUser.id }).where(eq(agentsTable.id, supportAgent.id));
  await tdb.update(contactsTable).set({ assignedAgentId: supportAgent.id }).where(eq(contactsTable.id, notMine.id));
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("My clients", () => {
  it("lists only the clients an agent services: assigned, or a policy they wrote", async () => {
    const res = await request(app).get("/api/agents/me/clients").set(withAuth(userA.id));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.total).toBe(2);
    expect(res.body.data.map((c: { lastName: string }) => c.lastName)).toEqual(["Alvarez", "Ortiz"]);
    // The list never carries the Medicare ID or health conditions.
    expect(JSON.stringify(res.body)).not.toMatch(/medicare|COPD|1EG4/i);

    const search = await request(app).get("/api/agents/me/clients?search=rosa").set(withAuth(userA.id));
    expect(search.body.data.map((c: { id: string }) => c.id)).toEqual([mine.id]);
  });

  it("shows an agent's own client with PHI, policies and applications", async () => {
    const res = await request(app).get(`/api/agents/me/clients/${mine.id}`).set(withAuth(userA.id));
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ medicareId: "1EG4TE5MK73", healthConditions: ["COPD", "Diabetes"] });
    expect(res.body.contact.dob).toMatch(/^1951-03-07/);

    const written = await request(app).get(`/api/agents/me/clients/${wroteForOther.id}`).set(withAuth(userA.id));
    expect(written.status).toBe(200);
    expect(written.body.policies[0]).toMatchObject({ writtenByMe: true, planName: "Humana Gold Plus" });
    expect(written.body.applications).toEqual([expect.objectContaining({ id: appWritten, canViewFull: true })]);
  });

  it("never shows another agent's client", async () => {
    const res = await request(app).get(`/api/agents/me/clients/${notMine.id}`).set(withAuth(userA.id));
    expect(res.status).toBe(404);
  });

  it("opens the full application the agent wrote (audited, with the Sunfire Medicare ID), and refuses others'", async () => {
    const full = await request(app).get(`/api/applications/${appWritten}/full`).set(withAuth(userA.id));
    expect(full.status).toBe(200);
    expect(full.body.medicareId).toBe("3CD4EF5GH67");
    expect(full.body.payload.fields["Has COPD (has_copd)"]).toBe("Yes");
    const audits = await tdb.select().from(auditLogTable).where(and(
      eq(auditLogTable.resourceId, appWritten), eq(auditLogTable.userId, userA.id), eq(auditLogTable.action, "view_full_application"),
    ));
    expect(audits).toHaveLength(1);

    const refused = await request(app).get(`/api/applications/${appNotMine}/full`).set(withAuth(userA.id));
    expect(refused.status).toBe(403);
    expect(await tdb.select().from(auditLogTable).where(and(
      eq(auditLogTable.resourceId, appNotMine), eq(auditLogTable.userId, userA.id),
    ))).toHaveLength(0);
  });

  it("the assigned agent can open it too; admins still see every application", async () => {
    expect((await request(app).get(`/api/applications/${appWritten}/full`).set(withAuth(userB.id))).status).toBe(200);
    expect((await request(app).get(`/api/applications/${appNotMine}/full`).set(withAuth(admin.id))).status).toBe(200);
  });

  it("says so when the user has no agent profile", async () => {
    const res = await request(app).get("/api/agents/me/clients").set(withAuth(admin.id));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no agent record/i);
  });

  it("a writing agent keeps PHI only while their policy is pending or active", async () => {
    // Written, not assigned, still pending: the writing agent sees the PHI.
    const live = await request(app).get(`/api/agents/me/clients/${wroteForOther.id}`).set(withAuth(userA.id));
    expect(live.body.contact).toMatchObject({ medicareId: "4CD5EF6GH78", healthConditions: ["CHF"] });
    expect(live.body.contact.dob).toMatch(/^1955-08-15/);
    // Cancelled: gone from their book, the detail and the full application.
    const list = await request(app).get("/api/agents/me/clients?limit=200").set(withAuth(userA.id));
    expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(ended.id);
    expect((await request(app).get(`/api/agents/me/clients/${ended.id}`).set(withAuth(userA.id))).status).toBe(404);
    expect((await request(app).get(`/api/applications/${appEnded}/full`).set(withAuth(userA.id))).status).toBe(403);
  });

  it("never widens a back-office role through a linked agent row", async () => {
    expect((await request(app).get(`/api/applications/${appNotMine}/full`).set(withAuth(supportUser.id))).status).toBe(403);
    expect((await request(app).get("/api/agents/me/clients").set(withAuth(supportUser.id))).status).toBe(404);
  });

  it("answers an agent the same for another's application and a made-up id", async () => {
    const other = await request(app).get(`/api/applications/${appNotMine}/full`).set(withAuth(userA.id));
    const missing = await request(app).get(`/api/applications/${randomUUID()}/full`).set(withAuth(userA.id));
    expect([other.status, missing.status]).toEqual([403, 403]);
    expect(missing.body).toEqual(other.body);
  });

  it("shows no Medicare ID at the top when the fields are ambiguous", async () => {
    const res = await request(app).get(`/api/applications/${appAmbiguous}/full`).set(withAuth(userA.id));
    expect(res.status).toBe(200);
    expect(res.body.medicareId).toBeNull();
    // An unambiguous fallback field is still used.
    const fallback = await request(app).get(`/api/applications/${appFallback}/full`).set(withAuth(userA.id));
    expect(fallback.body.medicareId).toBe("7HJ2CK3AB45");
  });
});
