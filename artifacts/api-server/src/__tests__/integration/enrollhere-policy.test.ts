/**
 * EnrollHere policy events, using a real delivery's shape (fake values):
 * contact upsert, enrollment, encrypted versioned application store, and the
 * audited "Full application" view.
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

import { readFileSync } from "fs";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import {
  activitiesTable,
  auditLogTable,
  contactsTable,
  enrollmentsTable,
  enrollmentApplicationsTable,
  enrollmentApplicationVersionsTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedAgent, seedUser, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

const SECRET = "eh-policy-secret";
let app: Express;
let request: typeof import("supertest");
let tdb: TestDb;
let org: { id: string };
let agent: { id: string };
let admin: { id: string };
let plainAgent: { id: string };

const sample = (): Record<string, any> =>
  JSON.parse(readFileSync(join(__dirname, "../fixtures/enrollhere-policy-created.json"), "utf8"));

beforeAll(async () => {
  process.env.ENROLLHERE_WEBHOOK_SECRET = SECRET;
  const handle = await bootTestDb();
  tdb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  org = await seedOrg(tdb, { id: "ehp-org" });
  agent = await seedAgent(tdb, { orgId: org.id, email: "chris.smith@sampleagency.com" });
  admin = await seedUser(tdb, { orgId: org.id, role: "agency_admin" });
  plainAgent = await seedUser(tdb, { orgId: org.id, role: "agent_support" });
});

afterAll(async () => {
  delete process.env.ENROLLHERE_WEBHOOK_SECRET;
  await shutdownTestDb();
});

const post = (body: unknown) =>
  request(app).post(`/api/integrations/enrollhere/v1/${org.id}/events`).set("X-Webhook-Secret", SECRET).send(body as object);

describe("EnrollHere policy events", () => {
  let contactId: string;
  let applicationId: string;

  it("creates the contact, enrollment, and an encrypted application from a real-shaped delivery", async () => {
    const res = await post(sample());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false, contactCreated: true, applicationVersion: 1 });
    contactId = res.body.contactId;
    applicationId = res.body.applicationId;

    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, contactId));
    expect(c).toMatchObject({
      firstName: "Alex", lastName: "Johnson", email: "alex.johnson@example.com", phone: "+15551234567",
      address1: "123 Main St", city: "Beverly Hills", stateCode: "CA", zipCode: "90210", assignedAgentId: agent.id,
    });
    expect(c!.dob!.toISOString().slice(0, 10)).toBe("1955-04-12");
    expect(c!.medicareIdEncrypted).not.toBeNull();

    const [e] = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, contactId));
    expect(e).toMatchObject({
      planId: "H1234-001", planName: "Sample Dual Integrated (HMO D-SNP)", planType: "MAPD", planYear: 2026,
      effectiveDate: "2026-01-01", applicationDate: "2025-12-01", policyNumber: "POL00012345",
      status: "active", effectuated: true, agentId: agent.id,
    });

    const [a] = await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, applicationId));
    expect(a).toMatchObject({
      applicationKey: "SF12345678", confirmationCode: "SF12345678", carrierName: "Carrier EH",
      planType: "PT_MAPD", snpType: "DSNP", policyStatus: "POL_INFORCE", effectiveDate: "2026-01-01",
      agentEmail: "chris.smith@sampleagency.com", agentNpn: "12345678", enrollmentId: e!.id, currentVersion: 1,
    });
    expect(a!.medicareIdEncrypted).not.toBeNull();

    // The stored payload is ciphertext: no plaintext PHI or health keys in it.
    const [v] = await tdb.select().from(enrollmentApplicationVersionsTable).where(eq(enrollmentApplicationVersionsTable.applicationId, applicationId));
    const raw = Buffer.from(v!.payloadEncrypted).toString("latin1");
    for (const s of ["Johnson", "1EG4TE5MK72", "diabetes", "copd"]) expect(raw).not.toContain(s);

    const [act] = await tdb.select().from(activitiesTable).where(eq(activitiesTable.contactId, contactId));
    expect(act).toMatchObject({ type: "enrollment" });
    expect(act!.body).toContain("Sample Dual Integrated");
  });

  it("dedupes a retry even though the relay's request headers changed", async () => {
    const retry = sample();
    retry.headers["x-request-id"] = "different-id";
    expect((await post(retry)).body).toEqual({ ok: true, duplicate: true });
  });

  it("adds a new version on update, on the same application and enrollment", async () => {
    const updated = sample();
    updated.event = "PE_POLICY_UPDATED";
    updated.policy.manualStatus = "POL_CANCELLED";
    updated.policy.automaticStatus = "POL_CANCELLED";
    const res = await post(updated);
    expect(res.body).toMatchObject({ duplicate: false, contactCreated: false, applicationId, applicationVersion: 2 });
    const enrollments = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, contactId));
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ status: "cancelled", effectuated: false });
    const [a] = await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, applicationId));
    expect(a).toMatchObject({ currentVersion: 2, policyStatus: "POL_CANCELLED", lastEventType: "PE_POLICY_UPDATED" });
  });

  it("lists applications for anyone who can read the contact, without PHI", async () => {
    const res = await request(app).get(`/api/contacts/${contactId}/applications`).set(withAuth(plainAgent.id));
    expect(res.status).toBe(200);
    expect(res.body.canViewFull).toBe(false);
    expect(res.body.applications[0]).toMatchObject({ id: applicationId, confirmationCode: "SF12345678", currentVersion: 2 });
    expect(JSON.stringify(res.body)).not.toMatch(/1EG4TE5MK72|medicare/i);
  });

  it("refuses the full application to non-privileged roles, and writes no audit entry", async () => {
    const res = await request(app).get(`/api/applications/${applicationId}/full`).set(withAuth(plainAgent.id));
    expect(res.status).toBe(403);
    const audits = await tdb.select().from(auditLogTable).where(and(
      eq(auditLogTable.resourceId, applicationId), eq(auditLogTable.userId, plainAgent.id), eq(auditLogTable.action, "view_full_application"),
    ));
    expect(audits).toHaveLength(0);
  });

  it("shows the full application to an admin and audits every view", async () => {
    const res = await request(app).get(`/api/applications/${applicationId}/full`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ version: 2, medicareId: "1EG4TE5MK72" });
    expect(res.body.payload.policy.manualStatus).toBe("POL_CANCELLED");
    expect(res.body.payload.headers).toBeUndefined(); // relay wrapper never stored
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const v1 = await request(app).get(`/api/applications/${applicationId}/full?version=1`).set(withAuth(admin.id));
    expect(v1.body.payload.policy.manualStatus).toBe("POL_INFORCE");

    const audits = await tdb.select().from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, applicationId), eq(auditLogTable.action, "view_full_application")));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ userId: admin.id, resourceType: "enrollment_application" });
  });

  it("keys an application without a Sunfire code on the EnrollHere policy id", async () => {
    const noSunfire = sample();
    noSunfire.policy.id = "policy-no-sunfire";
    delete noSunfire.policy.enrollment.identifiers.bySource.sunfire;
    delete noSunfire.policy.identifiers.bySource.sunfire;
    noSunfire.policy.enrollment.consumer.firstName = "Sam";
    noSunfire.policy.enrollment.consumer.medicare = {};
    noSunfire.policy.enrollment.medicareInfo.number = "";
    noSunfire.policy.enrollment.consumer.email = "sam@example.com";
    noSunfire.policy.enrollment.consumer.phone = "+15551110000";
    const res = await post(noSunfire);
    expect(res.status).toBe(200);
    const [a] = await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, res.body.applicationId));
    expect(a).toMatchObject({ applicationKey: "policy:policy-no-sunfire", confirmationCode: null });
  });

  it("an update without a Medicare number clears it; older versions still show their own", async () => {
    const noMbi = sample();
    noMbi.event = "PE_POLICY_UPDATED";
    noMbi.policy.manualStatus = "POL_CANCELLED";
    noMbi.policy.enrollment.consumer.medicare = {};
    noMbi.policy.enrollment.medicareInfo.number = "";
    noMbi.policy.lead.medicare = {};
    const res = await post(noMbi);
    expect(res.body).toMatchObject({ applicationId, applicationVersion: 3 });
    const [a] = await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, applicationId));
    expect(a!.medicareIdEncrypted).toBeNull();
    expect(a!.medicareIdHash).toBeNull();

    const v3 = await request(app).get(`/api/applications/${applicationId}/full`).set(withAuth(admin.id));
    expect(v3.body).toMatchObject({ version: 3, medicareId: null });
    const v1 = await request(app).get(`/api/applications/${applicationId}/full?version=1`).set(withAuth(admin.id));
    expect(v1.body).toMatchObject({ version: 1, medicareId: "1EG4TE5MK72" });
  });

  it("re-keys a code-less application when the Sunfire code arrives, keeping one history", async () => {
    const first = sample();
    first.policy.id = "policy-late-code";
    delete first.policy.enrollment.identifiers.bySource.sunfire;
    delete first.policy.identifiers.bySource.sunfire;
    const created = await post(first);
    expect(created.status).toBe(200);

    const later = sample();
    later.event = "PE_POLICY_UPDATED";
    later.policy.id = "policy-late-code";
    later.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF99990000"];
    delete later.policy.identifiers.bySource.sunfire;
    const res = await post(later);
    expect(res.body).toMatchObject({ applicationId: created.body.applicationId, applicationVersion: 2 });
    const [a] = await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, created.body.applicationId));
    expect(a).toMatchObject({ applicationKey: "SF99990000", confirmationCode: "SF99990000", currentVersion: 2 });
    expect(await tdb.select().from(enrollmentApplicationsTable)
      .where(eq(enrollmentApplicationsTable.externalPolicyId, "policy-late-code"))).toHaveLength(1);
  });

  it("a deleted contact's application can't be opened, and a purge removes it", async () => {
    await tdb.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, contactId));
    const res = await request(app).get(`/api/applications/${applicationId}/full`).set(withAuth(admin.id));
    expect(res.status).toBe(404);

    await tdb.delete(activitiesTable).where(eq(activitiesTable.contactId, contactId));
    await tdb.delete(contactsTable).where(eq(contactsTable.id, contactId));
    expect(await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, applicationId))).toHaveLength(0);
    expect(await tdb.select().from(enrollmentApplicationVersionsTable).where(eq(enrollmentApplicationVersionsTable.applicationId, applicationId))).toHaveLength(0);
  });
});

describe("policy event parsing", () => {
  it("never counts a negative status as active coverage", async () => {
    const { mapPolicyStatus } = await import("../../lib/integrations/enrollhere/policyEvent");
    for (const s of ["POL_INACTIVE", "POL_NOT_INFORCE", "NON_EFFECTUATED", "POL_NOT_ACTIVE"]) {
      expect(mapPolicyStatus(s)).toEqual({ status: "pending", effectuated: false });
    }
    expect(mapPolicyStatus("POL_INFORCE")).toEqual({ status: "active", effectuated: true });
    expect(mapPolicyStatus("POL_IN_FORCE")).toEqual({ status: "active", effectuated: true });
  });

  it("treats an impossible calendar date as absent", async () => {
    const { policyDate } = await import("../../lib/integrations/enrollhere/policyEvent");
    expect(policyDate({ date: "2026-02-30T12:00:00.000Z" })).toBeNull();
    expect(policyDate({ date: "2026-99-01" })).toBeNull();
    expect(policyDate({ date: "2026-01-01T12:00:00.000Z" })).toBe("2026-01-01");
  });

  it("fills missing person fields from the lead when the consumer is empty or partial", async () => {
    const { parsePolicyEvent } = await import("../../lib/integrations/enrollhere/policyEvent");
    const body = sample();
    const consumer = body.policy.enrollment.consumer;
    body.policy.lead = { ...consumer, email: "lead@example.com" };
    body.policy.enrollment.consumer = { firstName: "Casey" };
    const p = parsePolicyEvent(body);
    expect(p.contactFlat).toMatchObject({ first_name: "Casey", last_name: "Johnson", email: "lead@example.com", dob: "1955-04-12", city: "Beverly Hills" });
    body.policy.enrollment.consumer = {};
    expect(parsePolicyEvent(body).contactFlat.first_name).toBe("Alex");
  });
});
