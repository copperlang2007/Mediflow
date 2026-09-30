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
let notInForce: { id: string };
let appNotInForce: string;
let appShared: string;
let appAgreeing: string;
let suspendedUser: { id: string };
let sharedClient: { id: string };
let appEmailMismatch: string;
let freestanding: { id: string };
let appFreestanding: string;
let corrected: { id: string };
let appCorrected: string;
let appMbiAndHicn: string;
let legacy: { id: string };
let appLegacy: string;

const NPN_A = "17654321";
const NPN_B = "18765432";

async function seedApplication(
  contactId: string,
  enrollmentId: string | null,
  fields: Record<string, string>,
  writer: { writingAgentId?: string; agentNpn?: string; agentEmail?: string; policyStatus?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await tdb.insert(enrollmentApplicationsTable).values({
    id, orgId: org.id, source: "gohighlevel", applicationKey: `key-${id}`, contactId, enrollmentId,
    planName: "Humana Gold Plus", carrierName: "Humana", currentVersion: 1,
    agentNpn: writer.agentNpn ?? null, agentEmail: writer.agentEmail ?? null, policyStatus: writer.policyStatus ?? null,
    writingAgentId: writer.writingAgentId ?? null,
  });
  const { encrypted, hash } = encryptPii(JSON.stringify({ source: "gohighlevel", ghlContactId: "g1", fields }));
  await tdb.insert(enrollmentApplicationVersionsTable).values({
    id: randomUUID(), applicationId: id, version: 1, eventType: "GHL_SUNFIRE_APPLICATION", payloadEncrypted: encrypted, payloadHmac: hash,
  });
  return id;
}

async function seedEnrollment(contactId: string, agentId: string, status: "pending" | "cancelled" = "pending", planYear = 2027): Promise<string> {
  const id = randomUUID();
  await tdb.insert(enrollmentsTable).values({
    id, orgId: org.id, contactId, agentId, planType: "MA", planYear, effectiveDate: "2027-01-01", planName: "Humana Gold Plus", status,
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
  await tdb.update(agentsTable).set({ userId: userA.id, npn: NPN_A }).where(eq(agentsTable.id, agentA.id));
  await tdb.update(agentsTable).set({ userId: userB.id, npn: NPN_B }).where(eq(agentsTable.id, agentB.id));

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
  appWritten = await seedApplication(wroteForOther.id, written, { "Medicare Number (medicare_number)": "3CD4EF5GH67", "Has COPD (has_copd)": "Yes" }, { agentNpn: NPN_A, writingAgentId: agentA.id });
  const theirs = await seedEnrollment(notMine.id, agentB.id);
  appNotMine = await seedApplication(notMine.id, theirs, { "Medicare Number (medicare_number)": "2AB3CD4EF56" }, { agentNpn: NPN_B, writingAgentId: agentB.id });
  // A policy agent A wrote that has since been cancelled: no longer theirs to service.
  const cancelled = await seedEnrollment(ended.id, agentA.id, "cancelled");
  appEnded = await seedApplication(ended.id, cancelled, { "Medicare Number (medicare_number)": "5DE6FG7HJ89" }, { agentNpn: NPN_A, writingAgentId: agentA.id });
  appAmbiguous = await seedApplication(mine.id, null, {
    "Spouse Medicare Number (medicare_number)": "9SP1OU2SE34",
    "Medicare Number (medicare_number)": "1EG4TE5MK73",
  });
  appFallback = await seedApplication(mine.id, null, {
    "Spouse Medicare Number (medicare_number)": "9SP1OU2SE34",
    "Medicare Number (medicare_number)": "1EG4TE5MK73",
    "Applicant HICN (applicanthicn)": "7HJ2CK3AB45",
  });
  appAgreeing = await seedApplication(mine.id, null, {
    "Medicare Number (medicare_number)": "1EG4-TE5-MK73",
    "Applicant HICN (applicanthicn)": "1EG4TE5MK73",
  });
  // The carrier feed reports "not in force": the enrollment stays `pending`,
  // but the writing agent no longer services it.
  notInForce = await seedContact(tdb, { orgId: org.id, firstName: "Frank", lastName: "Hale", medicareId: "6EF7GH8JK90" });
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, notInForce.id));
  const inactive = await seedEnrollment(notInForce.id, agentA.id);
  appNotInForce = await seedApplication(notInForce.id, inactive, {}, { agentNpn: NPN_A, writingAgentId: agentA.id, policyStatus: "POL_NOT_INFORCE" });
  // Two policies share one enrollment row, which keeps its first writer (B):
  // A wrote this application, so A may open it and B (not assigned) may not.
  sharedClient = await seedContact(tdb, { orgId: org.id, firstName: "Gail", lastName: "Moss", medicareId: "7FG8HJ9KL01" });
  const shared = await seedEnrollment(sharedClient.id, agentB.id);
  appShared = await seedApplication(sharedClient.id, shared, { "Medicare Number (medicare_number)": "7FG8HJ9KL01" }, { agentNpn: NPN_A, writingAgentId: agentA.id });
  // The application names B by NPN; A's email on it doesn't make it A's.
  const agentAEmail = (await tdb.select({ email: agentsTable.email }).from(agentsTable).where(eq(agentsTable.id, agentA.id)))[0]!.email;
  const theirsToo = await seedEnrollment(notMine.id, agentB.id, "pending", 2028);
  appEmailMismatch = await seedApplication(notMine.id, theirsToo, {}, { agentNpn: NPN_B, agentEmail: agentAEmail, writingAgentId: agentB.id });
  // Stored before its plan was known: no enrollment, so no policy lifetime.
  freestanding = await seedContact(tdb, { orgId: org.id, firstName: "Hana", lastName: "Reed", medicareId: "8GH9JK1LM23" });
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, freestanding.id));
  appFreestanding = await seedApplication(freestanding.id, null, {}, { agentNpn: NPN_A, writingAgentId: agentA.id });
  // The carrier said "not in force", then corrected it to in force.
  corrected = await seedContact(tdb, { orgId: org.id, firstName: "Ivan", lastName: "Cole", medicareId: "9HJ1KL2MN34" });
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, corrected.id));
  const correctedEnr = await seedEnrollment(corrected.id, agentA.id);
  await seedApplication(corrected.id, correctedEnr, {}, { writingAgentId: agentA.id, policyStatus: "POL_NOT_INFORCE" });
  appCorrected = await seedApplication(corrected.id, correctedEnr, {}, { writingAgentId: agentA.id, policyStatus: "POL_INFORCE" });
  appMbiAndHicn = await seedApplication(mine.id, null, {
    "Medicare Number (medicare_number)": "1EG4TE5MK73",
    "Applicant HICN (applicanthicn)": "123456789A",
  });
  // A legacy application naming no writer at all: its enrollment's agent (A) wrote it.
  legacy = await seedContact(tdb, { orgId: org.id, firstName: "Jo", lastName: "Lane", medicareId: "1JK2LM3NP45" });
  await tdb.update(contactsTable).set({ assignedAgentId: agentB.id }).where(eq(contactsTable.id, legacy.id));
  const legacyEnr = await seedEnrollment(legacy.id, agentA.id);
  appLegacy = await seedApplication(legacy.id, legacyEnr, {});
  // A suspended agent keeps their login but services no one.
  suspendedUser = await seedUser(tdb, { orgId: org.id, role: "agent" });
  const suspended = await seedAgent(tdb, { orgId: org.id });
  await tdb.update(agentsTable).set({ userId: suspendedUser.id, status: "suspended", npn: "19876543" }).where(eq(agentsTable.id, suspended.id));
  await tdb.update(contactsTable).set({ assignedAgentId: suspended.id }).where(eq(contactsTable.id, ended.id));
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
    expect(res.body.total).toBe(5);
    expect(res.body.data.map((c: { lastName: string }) => c.lastName)).toEqual(["Alvarez", "Cole", "Lane", "Moss", "Ortiz"]);
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

  it("treats a carrier 'not in force' status as ended for the writing agent", async () => {
    const list = await request(app).get("/api/agents/me/clients?limit=200").set(withAuth(userA.id));
    expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(notInForce.id);
    expect((await request(app).get(`/api/agents/me/clients/${notInForce.id}`).set(withAuth(userA.id))).status).toBe(404);
    expect((await request(app).get(`/api/applications/${appNotInForce}/full`).set(withAuth(userA.id))).status).toBe(403);
  });

  it("authorizes an application's own writer, not whoever else is on a shared enrollment row", async () => {
    expect((await request(app).get(`/api/applications/${appShared}/full`).set(withAuth(userA.id))).status).toBe(200);
    expect((await request(app).get(`/api/applications/${appShared}/full`).set(withAuth(userB.id))).status).toBe(403);
    // The client (and their PHI) follows the application's writer too.
    const mineToo = await request(app).get(`/api/agents/me/clients/${sharedClient.id}`).set(withAuth(userA.id));
    expect(mineToo.status).toBe(200);
    expect(mineToo.body.contact.medicareId).toBe("7FG8HJ9KL01");
    expect((await request(app).get(`/api/agents/me/clients/${sharedClient.id}`).set(withAuth(userB.id))).status).toBe(404);
  });

  it("an application stored without an enrollment grants its writer nothing (the assigned agent still sees it)", async () => {
    expect((await request(app).get(`/api/applications/${appFreestanding}/full`).set(withAuth(userA.id))).status).toBe(403);
    expect((await request(app).get(`/api/agents/me/clients/${freestanding.id}`).set(withAuth(userA.id))).status).toBe(404);
    expect((await request(app).get(`/api/applications/${appFreestanding}/full`).set(withAuth(userB.id))).status).toBe(200);
  });

  it("follows each application's own status: a later in-force correction keeps the client", async () => {
    const detail = await request(app).get(`/api/agents/me/clients/${corrected.id}`).set(withAuth(userA.id));
    expect(detail.status).toBe(200);
    expect(detail.body.policies[0].writtenByMe).toBe(true);
    expect((await request(app).get(`/api/applications/${appCorrected}/full`).set(withAuth(userA.id))).status).toBe(200);
  });

  it("credits an application that names no writer to its enrollment's agent", async () => {
    const d = await request(app).get(`/api/agents/me/clients/${legacy.id}`).set(withAuth(userA.id));
    expect(d.status).toBe(200);
    expect(d.body.policies[0].writtenByMe).toBe(true);
    expect(d.body.applications[0].canViewFull).toBe(true);
    expect((await request(app).get(`/api/applications/${appLegacy}/full`).set(withAuth(userA.id))).status).toBe(200);
  });

  it("labels a shared enrollment 'written by you' from the application's writer", async () => {
    const a = await request(app).get(`/api/agents/me/clients/${sharedClient.id}`).set(withAuth(userA.id));
    expect(a.body.policies[0].writtenByMe).toBe(true);
  });

  it("never falls back to email when the application's NPN names another agent", async () => {
    expect((await request(app).get(`/api/applications/${appEmailMismatch}/full`).set(withAuth(userA.id))).status).toBe(403);
    expect((await request(app).get(`/api/agents/me/clients/${notMine.id}`).set(withAuth(userA.id))).status).toBe(404);
  });

  it("gives a suspended agent nothing, even for clients still assigned to them", async () => {
    expect((await request(app).get("/api/agents/me/clients").set(withAuth(suspendedUser.id))).status).toBe(404);
    expect((await request(app).get(`/api/applications/${appEnded}/full`).set(withAuth(suspendedUser.id))).status).toBe(403);
  });

  it("shows no Medicare ID at the top when the fields are ambiguous", async () => {
    const res = await request(app).get(`/api/applications/${appAmbiguous}/full`).set(withAuth(userA.id));
    expect(res.status).toBe(200);
    expect(res.body.medicareId).toBeNull();
    // A conflicting MBI key shows nothing and doesn't fall through to the HICN.
    const fallback = await request(app).get(`/api/applications/${appFallback}/full`).set(withAuth(userA.id));
    expect(fallback.body.medicareId).toBeNull();
    // One MBI wins over a (different) legacy HICN.
    const both = await request(app).get(`/api/applications/${appMbiAndHicn}/full`).set(withAuth(userA.id));
    expect(both.body.medicareId).toBe("1EG4TE5MK73");
    // Fields that agree (formatting aside) are shown.
    const agreeing = await request(app).get(`/api/applications/${appAgreeing}/full`).set(withAuth(userA.id));
    expect(agreeing.body.medicareId).toBe("1EG4TE5MK73");
  });
});
