/**
 * Calendar appointments API (stage2/calendar-branding).
 *
 * Pins: auth required, org scoping on every verb, the `agent` role narrowed to
 * its own calendar and its own contacts, notes encrypted at rest and masked
 * for roles that may not read PHI, and the basic CRUD happy path.
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

import { eq } from "drizzle-orm";
import { appointmentsTable, agentsTable, contactsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string };
let adminB: { id: string };
let viewerA: { id: string };
let agentUserA: { id: string };
let agentUserNoProfile: { id: string };
let agentA: { id: string };
let otherAgentA: { id: string };
let contactMine: { id: string };
let contactOther: { id: string };
let contactB: { id: string };

const FROM = "2026-10-01T00:00:00.000Z";
const TO = "2026-11-01T00:00:00.000Z";

function body(over: Record<string, unknown> = {}) {
  return {
    title: "Annual plan review",
    type: "review",
    status: "confirmed",
    startsAt: "2026-10-12T15:00:00.000Z",
    endsAt: "2026-10-12T15:30:00.000Z",
    locationType: "phone",
    ...over,
  };
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest")).default;

  orgA = await seedOrg(testDb, { name: "Appt Alpha" });
  orgB = await seedOrg(testDb, { name: "Appt Beta" });
  adminA = await seedUser(testDb, { orgId: orgA.id, role: "agency_admin" });
  adminB = await seedUser(testDb, { orgId: orgB.id, role: "agency_admin" });
  viewerA = await seedUser(testDb, { orgId: orgA.id, role: "viewer" });
  agentUserA = await seedUser(testDb, { orgId: orgA.id, role: "agent" });
  agentUserNoProfile = await seedUser(testDb, { orgId: orgA.id, role: "agent" });
  agentA = await seedAgent(testDb, { orgId: orgA.id, firstName: "Carla" });
  otherAgentA = await seedAgent(testDb, { orgId: orgA.id, firstName: "Otto" });
  await testDb.update(agentsTable).set({ userId: agentUserA.id }).where(eq(agentsTable.id, agentA.id));

  contactMine = await seedContact(testDb, { orgId: orgA.id, firstName: "Mina" });
  contactOther = await seedContact(testDb, { orgId: orgA.id, firstName: "Olga" });
  contactB = await seedContact(testDb, { orgId: orgB.id, firstName: "Bea" });
  await testDb
    .update(contactsTable)
    .set({ assignedAgentId: agentA.id })
    .where(eq(contactsTable.id, contactMine.id));
  await testDb
    .update(contactsTable)
    .set({ assignedAgentId: otherAgentA.id })
    .where(eq(contactsTable.id, contactOther.id));
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("appointments — auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get(`/api/appointments?from=${FROM}&to=${TO}`);
    expect(res.status).toBe(401);
  });

  it("requires a bounded range", async () => {
    const res = await request(app).get("/api/appointments").set(withAuth(adminA.id));
    expect(res.status).toBe(400);
    const wide = await request(app)
      .get(`/api/appointments?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`)
      .set(withAuth(adminA.id));
    expect(wide.status).toBe(400);
  });

  it("viewer can read but not create", async () => {
    const res = await request(app).post("/api/appointments").set(withAuth(viewerA.id)).send(body());
    expect(res.status).toBe(403);
    const list = await request(app)
      .get(`/api/appointments?from=${FROM}&to=${TO}`)
      .set(withAuth(viewerA.id));
    expect(list.status).toBe(200);
  });
});

describe("appointments — admin CRUD + org scoping", () => {
  let apptId: string;

  it("creates, lists with summary, gets, updates and deletes", async () => {
    const created = await request(app)
      .post("/api/appointments")
      .set(withAuth(adminA.id))
      .send(body({ contactId: contactMine.id, agentId: agentA.id, notes: "Wants to keep Dr. Patel" }));
    expect(created.status).toBe(201);
    apptId = created.body.id;
    expect(created.body.contact.firstName).toBe("Mina");
    expect(created.body.agent.firstName).toBe("Carla");
    expect(created.body.notes).toBe("Wants to keep Dr. Patel");

    const list = await request(app)
      .get(`/api/appointments?from=${FROM}&to=${TO}`)
      .set(withAuth(adminA.id));
    expect(list.status).toBe(200);
    expect(list.body.data.map((a: { id: string }) => a.id)).toContain(apptId);
    expect(list.body.summary.total).toBeGreaterThanOrEqual(1);
    expect(list.body.summary.confirmed).toBeGreaterThanOrEqual(1);

    const patched = await request(app)
      .patch(`/api/appointments/${apptId}`)
      .set(withAuth(adminA.id))
      .send({ status: "completed" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("completed");
  });

  it("stores notes only as ciphertext", async () => {
    const [row] = await testDb
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, apptId));
    expect(row.notesEncrypted).toBeTruthy();
    expect(Buffer.from(row.notesEncrypted!).toString("utf8")).not.toContain("Dr. Patel");
  });

  it("masks notes for a role that may not read PHI", async () => {
    const res = await request(app).get(`/api/appointments/${apptId}`).set(withAuth(viewerA.id));
    expect(res.status).toBe(200);
    expect(res.body.notes).toBeNull();
    expect(res.body.notesMasked).toBe(true);
  });

  it("hides the appointment from another org on every verb", async () => {
    const get = await request(app).get(`/api/appointments/${apptId}`).set(withAuth(adminB.id));
    expect(get.status).toBe(404);
    const patch = await request(app)
      .patch(`/api/appointments/${apptId}`)
      .set(withAuth(adminB.id))
      .send({ title: "hijack" });
    expect(patch.status).toBe(404);
    const del = await request(app).delete(`/api/appointments/${apptId}`).set(withAuth(adminB.id));
    expect(del.status).toBe(404);
    const list = await request(app)
      .get(`/api/appointments?from=${FROM}&to=${TO}`)
      .set(withAuth(adminB.id));
    expect(list.body.data).toHaveLength(0);
  });

  it("refuses to link a contact or agent from another org", async () => {
    const res = await request(app)
      .post("/api/appointments")
      .set(withAuth(adminA.id))
      .send(body({ contactId: contactB.id }));
    expect(res.status).toBe(400);
    const res2 = await request(app)
      .post("/api/appointments")
      .set(withAuth(adminB.id))
      .send(body({ agentId: agentA.id }));
    expect(res2.status).toBe(400);
  });

  it("validates times and meeting links", async () => {
    const backwards = await request(app)
      .post("/api/appointments")
      .set(withAuth(adminA.id))
      .send(body({ endsAt: "2026-10-12T14:00:00.000Z" }));
    expect(backwards.status).toBe(400);
    const badUrl = await request(app)
      .post("/api/appointments")
      .set(withAuth(adminA.id))
      .send(body({ locationType: "video", meetingUrl: "javascript:alert(1)" }));
    expect(badUrl.status).toBe(400);
  });

  it("resets the reminder claim when rescheduled", async () => {
    await testDb
      .update(appointmentsTable)
      .set({ reminderSentAt: new Date() })
      .where(eq(appointmentsTable.id, apptId));
    const res = await request(app)
      .patch(`/api/appointments/${apptId}`)
      .set(withAuth(adminA.id))
      .send({ startsAt: "2026-10-13T15:00:00.000Z", endsAt: "2026-10-13T15:30:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.reminderSentAt).toBeNull();
  });

  it("deletes", async () => {
    const del = await request(app).delete(`/api/appointments/${apptId}`).set(withAuth(adminA.id));
    expect(del.status).toBe(204);
    const get = await request(app).get(`/api/appointments/${apptId}`).set(withAuth(adminA.id));
    expect(get.status).toBe(404);
  });
});

describe("appointments — agent role sees and manages only their own", () => {
  let othersAppt: string;
  let mineAppt: string;

  it("forces the agent's own agentId and accepts their own contact", async () => {
    const res = await request(app)
      .post("/api/appointments")
      .set(withAuth(agentUserA.id))
      .send(body({ contactId: contactMine.id }));
    expect(res.status).toBe(201);
    expect(res.body.agentId).toBe(agentA.id);
    mineAppt = res.body.id;
  });

  it("refuses booking for another agent or another agent's contact", async () => {
    const forOther = await request(app)
      .post("/api/appointments")
      .set(withAuth(agentUserA.id))
      .send(body({ agentId: otherAgentA.id }));
    expect(forOther.status).toBe(403);
    const othersContact = await request(app)
      .post("/api/appointments")
      .set(withAuth(agentUserA.id))
      .send(body({ contactId: contactOther.id }));
    expect(othersContact.status).toBe(403);
  });

  it("lists only their own appointments", async () => {
    const other = await request(app)
      .post("/api/appointments")
      .set(withAuth(adminA.id))
      .send(body({ agentId: otherAgentA.id, title: "Other agent's meeting" }));
    othersAppt = other.body.id;

    const list = await request(app)
      .get(`/api/appointments?from=${FROM}&to=${TO}`)
      .set(withAuth(agentUserA.id));
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe("own");
    const ids = list.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(mineAppt);
    expect(ids).not.toContain(othersAppt);
  });

  it("cannot read, edit or delete another agent's appointment", async () => {
    expect((await request(app).get(`/api/appointments/${othersAppt}`).set(withAuth(agentUserA.id))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/appointments/${othersAppt}`).set(withAuth(agentUserA.id)).send({ title: "x" })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/appointments/${othersAppt}`).set(withAuth(agentUserA.id))).status).toBe(404);
  });

  it("contact picker only offers the agent's own contacts", async () => {
    const res = await request(app)
      .get("/api/appointments/contact-options")
      .set(withAuth(agentUserA.id));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(contactMine.id);
    expect(ids).not.toContain(contactOther.id);
    expect(ids).not.toContain(contactB.id);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["assignedAgentId", "firstName", "id", "lastName"]);
  });

  it("an agent login with no agent profile gets an empty calendar and cannot book", async () => {
    const list = await request(app)
      .get(`/api/appointments?from=${FROM}&to=${TO}`)
      .set(withAuth(agentUserNoProfile.id));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);
    const post = await request(app)
      .post("/api/appointments")
      .set(withAuth(agentUserNoProfile.id))
      .send(body());
    expect(post.status).toBe(403);
    expect(post.body.code).toBe("no_agent_profile");
  });
});
