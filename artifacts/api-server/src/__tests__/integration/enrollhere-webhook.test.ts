/**
 * EnrollHere inbound webhook: auth (HMAC + static header, fail-closed),
 * contact upsert with the CSV importer's dedupe rules, call logging, and
 * idempotent redelivery.
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
import { activitiesTable, contactsTable, integrationEventsTable } from "@workspace/db/schema";
import { computeSignature } from "../../lib/dialer/signature";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent, seedContact, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

const SECRET = "eh-test-secret";
let app: Express;
let request: typeof import("supertest");
let tdb: TestDb;
let org: { id: string };
let agent: { id: string };

beforeAll(async () => {
  process.env.ENROLLHERE_WEBHOOK_SECRET = SECRET;
  const handle = await bootTestDb();
  tdb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  org = await seedOrg(tdb, { id: "eh-org" });
  agent = await seedAgent(tdb, { orgId: org.id, email: "closer@agency.example" });
  await seedContact(tdb, { orgId: org.id, firstName: "Ruth", lastName: "Known", email: "ruth@example.com" });
});

afterAll(async () => {
  delete process.env.ENROLLHERE_WEBHOOK_SECRET;
  await shutdownTestDb();
});

const url = () => `/api/integrations/enrollhere/v1/${org.id}/events`;

function signed(body: unknown, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return request(app).post(url()).set("Content-Type", "application/json")
    .set("X-MB-Signature", `t=${t},v1=${computeSignature(secret, t, raw)}`).send(raw);
}

function withHeaderSecret(body: unknown, secret = SECRET) {
  return request(app).post(url()).set("X-Webhook-Secret", secret).send(body as object);
}

describe("EnrollHere webhook auth", () => {
  const body = { call_id: "auth-1", first_name: "A", last_name: "B" };

  it("rejects a missing, wrong, or stale credential", async () => {
    expect((await request(app).post(url()).send(body)).status).toBe(401);
    expect((await withHeaderSecret(body, "nope")).status).toBe(401);
    expect((await signed(body, "nope")).status).toBe(401);
    expect((await signed(body, SECRET, Math.floor(Date.now() / 1000) - 3600)).status).toBe(403);
    expect((await request(app).post(url()).set("Authorization", "Bearer nope").send(body)).status).toBe(401);
  });

  it("fails closed when no secret is configured", async () => {
    const prev = process.env.ENROLLHERE_WEBHOOK_SECRET;
    delete process.env.ENROLLHERE_WEBHOOK_SECRET;
    try {
      expect((await withHeaderSecret(body)).status).toBe(401);
    } finally {
      process.env.ENROLLHERE_WEBHOOK_SECRET = prev;
    }
  });

  it("404s an unknown org after auth", async () => {
    const res = await request(app).post("/api/integrations/enrollhere/v1/no-such-org/events")
      .set("X-Webhook-Secret", SECRET).send(body);
    expect(res.status).toBe(404);
  });
});

describe("EnrollHere webhook processing", () => {
  it("creates a contact from a flat signed payload and logs the call", async () => {
    const res = await signed({
      event: "call.completed",
      call_id: "call-100",
      first_name: "Gloria",
      last_name: "Vance",
      phone: "(512) 555-0142",
      date_of_birth: "02/14/1951",
      medicare_id: "1EG4-TE5-MK73",
      zip: "78701",
      agent_email: "Closer@Agency.example",
      direction: "inbound",
      duration: "4:05",
      disposition: "Enrolled",
      recording_url: "https://recordings.example/abc.mp3",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false, contactCreated: true });

    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res.body.contactId));
    expect(c).toMatchObject({
      firstName: "Gloria",
      lastName: "Vance",
      phone: "+15125550142",
      zipCode: "78701",
      assignedAgentId: agent.id,
      leadSource: "EnrollHere",
    });
    expect(c!.medicareIdEncrypted).not.toBeNull();

    const [a] = await tdb.select().from(activitiesTable).where(eq(activitiesTable.id, res.body.activityId));
    expect(a).toMatchObject({ type: "call_log", contactId: c!.id, agentId: agent.id, body: "EnrollHere inbound call 4m 5s — Enrolled" });
    expect(a!.metadata).toMatchObject({ durationSeconds: 245, recordingUrl: "https://recordings.example/abc.mp3", externalId: "call-100" });
  });

  it("is idempotent on redelivery of the same call", async () => {
    const body = { call_id: "call-200", first_name: "Dup", last_name: "Test", phone: "5125550200" };
    const first = await withHeaderSecret(body);
    const again = await withHeaderSecret(body);
    expect(first.status).toBe(200);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    const calls = await tdb.select().from(activitiesTable)
      .where(and(eq(activitiesTable.orgId, org.id), eq(activitiesTable.contactId, first.body.contactId)));
    expect(calls).toHaveLength(1);
  });

  it("reads a nested camelCase payload and merges into the existing contact", async () => {
    const res = await request(app).post(url()).set("Authorization", `Bearer ${SECRET}`).send({
      type: "call_ended",
      data: {
        callId: "call-300",
        contact: { firstName: "Ruth", lastName: "Known", email: "RUTH@example.com", address: { city: "Round Rock", state: "Texas" } },
        callDuration: 61,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.contactCreated).toBe(false);
    const ruths = await tdb.select().from(contactsTable)
      .where(and(eq(contactsTable.orgId, org.id), eq(contactsTable.firstName, "Ruth")));
    expect(ruths).toHaveLength(1);
    // The city in a nested address block must not land in the street field.
    expect(ruths[0]).toMatchObject({ city: "Round Rock", stateCode: "TX", address1: null });
  });

  it("keys a call with no id on the body hash, and records field names only", async () => {
    const body = { first_name: "No", last_name: "Id", phone: "5125550301", notes: "sensitive note" };
    const res = await withHeaderSecret(body);
    expect(res.status).toBe(200);
    const [evt] = await tdb.select().from(integrationEventsTable).where(eq(integrationEventsTable.activityId, res.body.activityId));
    expect(evt!.externalId).toMatch(/^sha256:/);
    expect(evt!.payloadKeys).toEqual(["first_name", "last_name", "phone", "notes"]);
    expect(JSON.stringify(evt)).not.toContain("sensitive note");
  });

  it("returns 422 naming the fields it got when there is no contact name", async () => {
    const res = await withHeaderSecret({ call_id: "call-400", caller_id: "5125550400" });
    expect(res.status).toBe(422);
    expect(res.body.fieldsReceived).toEqual(["call_id", "caller_id"]);
  });

  it("never takes the contact's own id for the call id", async () => {
    const person = { id: "contact-777", firstName: "Owen", lastName: "Idtest", phone: "5125550777" };
    const a = await withHeaderSecret({ id: "evt-1", type: "call", contact: person });
    const b = await withHeaderSecret({ id: "evt-2", type: "call", contact: person });
    expect(a.body.duplicate).toBe(false);
    expect(b.body.duplicate).toBe(false);
    expect(b.body.activityId).not.toBe(a.body.activityId);
  });

  it("dedupes an id-less redelivery even when the JSON key order changes", async () => {
    const first = await withHeaderSecret({ first_name: "Kay", last_name: "Order", phone: "5125550888" });
    const again = await request(app).post(url()).set("X-Webhook-Secret", SECRET).set("Content-Type", "application/json")
      .send('{ "phone": "5125550888",  "last_name": "Order", "first_name": "Kay" }');
    expect(first.body.duplicate).toBe(false);
    expect(again.body).toEqual({ ok: true, duplicate: true });
  });

  it("creates one contact when two deliveries for a new person arrive together", async () => {
    const person = { first_name: "Sim", last_name: "Ultaneous", phone: "5125550999" };
    const [r1, r2] = await Promise.all([
      withHeaderSecret({ call_id: "par-1", ...person }),
      withHeaderSecret({ call_id: "par-2", ...person }),
    ]);
    expect(r1.body.contactId).toBe(r2.body.contactId);
    const sims = await tdb.select().from(contactsTable).where(and(eq(contactsTable.orgId, org.id), eq(contactsTable.lastName, "Ultaneous")));
    expect(sims).toHaveLength(1);
  });

  it("keeps only https recording links", async () => {
    const res = await withHeaderSecret({ call_id: "rec-1", first_name: "Rec", last_name: "Link", recording_url: "javascript:alert(1)" });
    const [a] = await tdb.select().from(activitiesTable).where(eq(activitiesTable.id, res.body.activityId));
    expect((a!.metadata as { recordingUrl: unknown }).recordingUrl).toBeNull();
  });

  it("never stores a caller-ID display name as a phone number", async () => {
    const res = await withHeaderSecret({ call_id: "cid-1", first_name: "NoPhone", last_name: "Real", caller_id: "JOHN DOE" });
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res.body.contactId));
    expect(c!.phone).toBeNull();
  });

  it("does not take a call-leg 'caller' block's number over the person's own phone", async () => {
    const res = await withHeaderSecret({ call_id: "cid-2", first_name: "Top", last_name: "Level", phone: "5125550555", caller: { name: "Support Line", phone: "18005550000" } });
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res.body.contactId));
    expect(c!.phone).toBe("+15125550555");
  });
});
