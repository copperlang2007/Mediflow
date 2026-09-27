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

  it("dedupes a re-send whose only change is the activity timestamp", async () => {
    const resend = sample();
    resend.policy.lastActivityAt = { date: "2030-01-01T00:00:00.000Z", timestamp: 1893456000000 };
    expect((await post(resend)).body).toEqual({ ok: true, duplicate: true });
  });

  it("a partial update keeps the plan details an earlier delivery set", async () => {
    const partial = sample();
    partial.event = "PE_POLICY_UPDATED";
    partial.policy.manualStatus = "POL_SUBMITTED";
    partial.policy.enrollment.plan = {};
    delete partial.policy.enrollment.carrier;
    partial.policy.enrollment.details = {};
    delete partial.policy.effectiveDate;
    delete partial.policy.agent;
    delete partial.policy.enrollment.agent;
    const res = await post(partial);
    expect(res.status).toBe(200);
    const [a] = await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, applicationId));
    expect(a).toMatchObject({
      policyStatus: "POL_SUBMITTED", planName: "Sample Dual Integrated (HMO D-SNP)", carrierName: "Carrier EH",
      effectiveDate: "2026-01-01", agentEmail: "chris.smith@sampleagency.com",
    });
  });

  it("keeps one enrollment when a later delivery adds the carrier", async () => {
    const early = sample();
    early.policy.id = "policy-carrier-later";
    early.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF55550000"];
    delete early.policy.identifiers.bySource.sunfire;
    Object.assign(early.policy.enrollment.consumer, { firstName: "Robin", email: "robin@example.com", phone: "+15552220000" });
    early.policy.lead = undefined;
    const withCarrier = JSON.parse(JSON.stringify(early));
    delete early.policy.enrollment.carrier;
    const first = await post(early);
    expect(first.status).toBe(200);
    withCarrier.event = "PE_POLICY_UPDATED";
    const second = await post(withCarrier);
    expect(second.body).toMatchObject({ contactId: first.body.contactId, enrollmentId: first.body.enrollmentId });
    const rows = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, first.body.contactId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.carrierId).not.toBeNull();
  });

  it("records only the client address in the view audit", async () => {
    await request(app).get(`/api/applications/${applicationId}/full`).set(withAuth(admin.id))
      .set("X-Forwarded-For", "203.0.113.1, 10.0.0.1");
    const audits = await tdb.select().from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, applicationId), eq(auditLogTable.action, "view_full_application")));
    expect(audits.at(-1)!.ipAddress).not.toContain(",");
  });

  it("a failed decrypt writes no view audit", async () => {
    const [v] = await tdb.select().from(enrollmentApplicationVersionsTable)
      .where(and(eq(enrollmentApplicationVersionsTable.applicationId, applicationId), eq(enrollmentApplicationVersionsTable.version, 1)));
    const saved = v!.payloadEncrypted;
    await tdb.update(enrollmentApplicationVersionsTable).set({ payloadEncrypted: Buffer.alloc(32) }).where(eq(enrollmentApplicationVersionsTable.id, v!.id));
    const before = await tdb.select().from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, applicationId), eq(auditLogTable.action, "view_full_application")));
    const res = await request(app).get(`/api/applications/${applicationId}/full?version=1`).set(withAuth(admin.id));
    expect(res.status).toBe(500);
    const after = await tdb.select().from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, applicationId), eq(auditLogTable.action, "view_full_application")));
    expect(after).toHaveLength(before.length);
    await tdb.update(enrollmentApplicationVersionsTable).set({ payloadEncrypted: saved }).where(eq(enrollmentApplicationVersionsTable.id, v!.id));
  });

  it("marks a new in-force policyholder as enrolled", async () => {
    const [c] = await tdb.select({ status: contactsTable.status }).from(contactsTable).where(eq(contactsTable.id, contactId));
    expect(c!.status).toBe("enrolled");
  });

  it("a code-less update continues the coded application", async () => {
    const noCode = sample();
    noCode.event = "PE_POLICY_UPDATED";
    noCode.policy.manualStatus = "POL_INFORCE";
    delete noCode.policy.enrollment.identifiers.bySource.sunfire;
    delete noCode.policy.identifiers.bySource.sunfire;
    const res = await post(noCode);
    expect(res.body).toMatchObject({ applicationId });
    expect(await tdb.select().from(enrollmentApplicationsTable)
      .where(eq(enrollmentApplicationsTable.applicationKey, `policy:${sample().policy.id}`))).toHaveLength(0);
  });

  it("an update that moves the plan year lands on the same enrollment", async () => {
    const before = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, contactId));
    const moved = sample();
    moved.event = "PE_POLICY_UPDATED";
    moved.policy.enrollment.details.effectiveDate = { date: "2027-01-01T12:00:00.000Z" };
    const res = await post(moved);
    expect(res.status).toBe(200);
    const after = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, contactId));
    expect(after).toHaveLength(before.length);
    expect(after.find((e) => e.id === res.body.enrollmentId)).toMatchObject({ planYear: 2027, effectiveDate: "2027-01-01" });
  });

  it("a second policy in the same slot doesn't cancel the first one's in-force coverage", async () => {
    const first = sample();
    first.policy.id = "policy-slot-a";
    first.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF10000001"];
    delete first.policy.identifiers.bySource.sunfire;
    Object.assign(first.policy.enrollment.consumer, { firstName: "Jordan", email: "jordan@example.com", phone: "+15553330000" });
    first.policy.lead = undefined;
    const a = await post(first);
    expect(a.status).toBe(200);
    const second = JSON.parse(JSON.stringify(first));
    second.policy.id = "policy-slot-b";
    second.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF10000002"];
    second.policy.manualStatus = "POL_CANCELLED";
    const b = await post(second);
    expect(b.body.enrollmentId).toBe(a.body.enrollmentId);
    const [e] = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, a.body.enrollmentId));
    expect(e).toMatchObject({ status: "active", effectuated: true });
  });

  it("folds a code-less record into the one already holding its Sunfire code", async () => {
    const base = sample();
    Object.assign(base.policy.enrollment.consumer, { firstName: "Taylor", email: "taylor@example.com", phone: "+15554440000" });
    base.policy.lead = undefined;
    delete base.policy.identifiers.bySource.sunfire;
    const coded = JSON.parse(JSON.stringify(base));
    coded.policy.id = "policy-old-id";
    coded.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF20000001"];
    const codedRes = await post(coded);
    const codeless = JSON.parse(JSON.stringify(base));
    codeless.policy.id = "policy-new-id";
    delete codeless.policy.enrollment.identifiers.bySource.sunfire;
    await post(codeless);
    const late = JSON.parse(JSON.stringify(base));
    late.event = "PE_POLICY_UPDATED";
    late.policy.id = "policy-new-id";
    late.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF20000001"];
    const res = await post(late);
    expect(res.body).toMatchObject({ applicationId: codedRes.body.applicationId, applicationVersion: 3 });
    expect(await tdb.select().from(enrollmentApplicationsTable)
      .where(eq(enrollmentApplicationsTable.applicationKey, "policy:policy-new-id"))).toHaveLength(0);
    const versions = await tdb.select().from(enrollmentApplicationVersionsTable)
      .where(eq(enrollmentApplicationVersionsTable.applicationId, codedRes.body.applicationId));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
  });

  it("a deleted contact's application can't be opened, and a purge removes it", async () => {
    await tdb.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, contactId));
    const res = await request(app).get(`/api/applications/${applicationId}/full`).set(withAuth(admin.id));
    expect(res.status).toBe(404);

    // Later events for the deleted person's policy change nothing.
    const later = sample();
    later.event = "PE_POLICY_UPDATED";
    later.policy.manualStatus = "POL_TERMINATED";
    expect((await post(later)).body).toMatchObject({ ok: true, skipped: "contact_deleted" });
    // Nor does a new policy for them.
    const other = sample();
    other.policy.id = "policy-after-delete";
    other.policy.enrollment.identifiers.bySource.sunfire.ids = ["SF77770000"];
    delete other.policy.identifiers.bySource.sunfire;
    expect((await post(other)).body).toMatchObject({ skipped: "contact_deleted" });
    expect(await tdb.select().from(contactsTable).where(eq(contactsTable.email, "alex.johnson@example.com"))).toHaveLength(1);

    await tdb.delete(activitiesTable).where(eq(activitiesTable.contactId, contactId));
    await tdb.delete(contactsTable).where(eq(contactsTable.id, contactId));
    expect(await tdb.select().from(enrollmentApplicationsTable).where(eq(enrollmentApplicationsTable.id, applicationId))).toHaveLength(0);
    expect(await tdb.select().from(enrollmentApplicationVersionsTable).where(eq(enrollmentApplicationVersionsTable.applicationId, applicationId))).toHaveLength(0);

    // After the purge the policy link remains as a tombstone.
    const again = sample();
    again.event = "PE_POLICY_UPDATED";
    again.policy.manualStatus = "POL_CANCELLED";
    expect((await post(again)).body).toMatchObject({ skipped: "contact_deleted" });
    expect(await tdb.select().from(contactsTable).where(eq(contactsTable.email, "alex.johnson@example.com"))).toHaveLength(0);
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
    // Policy dates read a two-digit year as 20xx; birth dates as a plausible past year.
    expect(policyDate("1/1/27")).toBe("2027-01-01");
    expect(policyDate("4/12/55", "past")).toBe("1955-04-12");
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
