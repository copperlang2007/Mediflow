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
import { activitiesTable, agentsTable, contactsTable, integrationEventsTable } from "@workspace/db/schema";
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
  await tdb.update(agentsTable).set({ userId: "user-closer" }).where(eq(agentsTable.id, agent.id));
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
    expect((await request(app).post(url()).set("Content-Type", "application/json").send(JSON.stringify(body))).status).toBe(401);
    expect((await withHeaderSecret(body, "nope")).status).toBe(401);
    expect((await signed(body, "nope")).status).toBe(401);
    expect((await signed(body, SECRET, Math.floor(Date.now() / 1000) - 3600)).status).toBe(403);
    expect((await request(app).post(url()).set("Authorization", "Bearer nope").send(body)).status).toBe(401);
  });

  it("fails closed when no secret is configured", async () => {
    const prev = process.env.ENROLLHERE_WEBHOOK_SECRET;
    delete process.env.ENROLLHERE_WEBHOOK_SECRET;
    try {
      expect((await withHeaderSecret(body)).status).toBe(503);
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
    // createdBy = the agent's login, so agent-performance call counts include it.
    expect(a).toMatchObject({ type: "call_log", contactId: c!.id, agentId: agent.id, createdBy: "user-closer", body: "EnrollHere inbound call 4m 5s — Enrolled" });
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

  it("dedupes an id-less redelivery whose delivery metadata is nested", async () => {
    const body = (attempt: number, ts: string) => ({
      data: { contact: { first_name: "Nes", last_name: "Ted", phone: "5125550877" }, timestamp: ts, attempt },
      delivery: { id: `d-${attempt}`, attempt },
    });
    const first = await withHeaderSecret(body(1, "2026-09-26T10:00:00Z"));
    const again = await withHeaderSecret(body(2, "2026-09-26T10:05:00Z"));
    expect(first.body.duplicate).toBe(false);
    expect(again.body).toEqual({ ok: true, duplicate: true });
  });

  it("uses a phone alias that is a real number over a placeholder in `phone`", async () => {
    await withHeaderSecret({ call_id: "alias-1", first_name: "Alias", last_name: "One", phone: "Unknown", phone_number: "5125550100" });
    await withHeaderSecret({ call_id: "alias-2", first_name: "Alias", last_name: "Two", phone: "JOHN DOE", mobile: "5125550103" });
    const rows = await tdb.select().from(contactsTable).where(and(eq(contactsTable.orgId, org.id), eq(contactsTable.firstName, "Alias")));
    expect(rows.find((r) => r.lastName === "One")!.phone).toBe("+15125550100");
    expect(rows.find((r) => r.lastName === "Two")!.phone).toBe("+15125550103");
  });

  it("never uses the agent's nested address as the contact's address", async () => {
    await withHeaderSecret({ call_id: "agent-addr", contact: {
      // Agent block first, so the old first-wins rule would have taken its address.
      agent: { email: "closer@agency.example", address: { street: "1 Agent Way", city: "AGENT_CITY", state: "CA", zip: "90210" } },
      first_name: "Home", last_name: "Owner", phone: "5125550555",
      address: { street: "9 Client Ln", city: "Austin", state: "TX", zip: "78701" },
    } });
    const [c] = await tdb.select().from(contactsTable).where(and(eq(contactsTable.orgId, org.id), eq(contactsTable.firstName, "Home")));
    expect(c).toMatchObject({ address1: "9 Client Ln", city: "Austin", stateCode: "TX", zipCode: "78701" });
  });

  it("dedupes an id-less retry whose only change is a bumped created_at", async () => {
    const body = (at: string) => ({ first_name: "Cre", last_name: "Ated", phone: "5125550666", created_at: at });
    expect((await withHeaderSecret(body("2026-09-26T10:00:00Z"))).body.duplicate).toBe(false);
    expect((await withHeaderSecret(body("2026-09-26T10:03:00Z"))).body).toEqual({ ok: true, duplicate: true });
  });

  it("never takes a relative's or a call leg's number/email for the contact", async () => {
    await withHeaderSecret({ call_id: "kin-1", contact: {
      first_name: "Kin", last_name: "Safe",
      emergency_contact: { name: "Next Of Kin", phone: "5559998877" },
      spouse: { email: "spouse@example.com" },
    } });
    await withHeaderSecret({ call_id: "leg-1", first_name: "Vic", last_name: "Beneficiary", caller: { number: "18005550000", name: "Support Line" } });
    await withHeaderSecret({ call_id: "out-1", direction: "outbound", from: "5125550999", first_name: "Out", last_name: "Bound" });
    const rows = await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org.id));
    expect(rows.find((r) => r.lastName === "Safe")).toMatchObject({ phone: null, email: null });
    expect(rows.find((r) => r.lastName === "Beneficiary")!.phone).toBeNull();
    expect(rows.find((r) => r.lastName === "Bound")!.phone).toBeNull();
  });

  it("authenticates before revealing the content-type rule", async () => {
    const res = await request(app).post(url()).set("Content-Type", "text/plain").send("hello");
    expect(res.status).toBe(401);
  });

  it("does not treat a top-level entity id as the call id", async () => {
    const a = await withHeaderSecret({ id: "entity-abc", event: "call.started", first_name: "Ent", last_name: "Ity", phone: "5125550444" });
    const b = await withHeaderSecret({ id: "entity-abc", event: "call.completed", first_name: "Ent", last_name: "Ity", phone: "5125550444" });
    expect(a.body.duplicate).toBe(false);
    expect(b.body.duplicate).toBe(false);
  });

  // Note: pglite runs queries one at a time, so this passes with or without
  // the advisory lock. The race itself was verified on real Postgres 16 (see
  // the PR description); this guards the single-contact outcome.
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

  it("uses the caller ID when the payload's phone is a placeholder, and never stores a delivery timestamp as the call start", async () => {
    const res = await withHeaderSecret({ call_id: "cid-unknown", first_name: "Placeholder", last_name: "Phone", phone: "Unknown", caller_id: "5125551166", timestamp: "2026-05-15T09:30:00Z" });
    expect(res.status).toBe(200);
    const [c] = await tdb.select().from(contactsTable).where(and(eq(contactsTable.orgId, org.id), eq(contactsTable.firstName, "Placeholder")));
    expect(c!.phone).toBe("+15125551166");
    const [a] = await tdb.select().from(activitiesTable).where(eq(activitiesTable.contactId, c!.id));
    expect((a!.metadata as { startedAt?: unknown }).startedAt).toBeNull();
  });

  it("picks the same phone whatever the JSON key order", async () => {
    await withHeaderSecret({ call_id: "order-1", first_name: "Order", last_name: "One", cell: "5125550202", phone: "5125550101" });
    await withHeaderSecret({ call_id: "order-2", phone: "5125550303", cell: "5125550404", first_name: "Order", last_name: "Two" });
    const rows = await tdb.select().from(contactsTable).where(and(eq(contactsTable.orgId, org.id), eq(contactsTable.firstName, "Order")));
    const by = (last: string) => rows.find((r) => r.lastName === last)!.phone;
    expect(by("One")).toBe("+15125550101");
    expect(by("Two")).toBe("+15125550303");
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

  it("rejects non-JSON deliveries with 415", async () => {
    const noCt = await request(app).post(url()).set("X-Webhook-Secret", SECRET).unset("Content-Type")
      .send(Buffer.from('{"call_id":"ct-1","first_name":"No","last_name":"Ct"}'));
    expect(noCt.status).toBe(415);
    const form = await request(app).post(url()).set("X-Webhook-Secret", SECRET).type("form").send("first_name=Kate&last_name=Test");
    expect(form.status).toBe(415);
  });

  it("does not apply the CSV shift heuristic to JSON payloads", async () => {
    const res = await withHeaderSecret({ call_id: "shift-1", first_name: "Valid", last_name: "Person", state: "Austin", zip: "TX", date_of_birth: "totally-bogus" });
    expect(res.status).toBe(200);
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res.body.contactId));
    expect(c).toMatchObject({ stateCode: null, zipCode: null, dob: null });
  });

  it("logs each call when the only id in the payload is the contact's", async () => {
    const person = { id: "cust-777", first_name: "Cid", last_name: "Collide", phone: "5125550778" };
    const a = await withHeaderSecret({ contact: person, event: "call.started", duration: 5 });
    const b = await withHeaderSecret({ contact: person, event: "call.completed", duration: 90 });
    expect(a.body.duplicate).toBe(false);
    expect(b.body.duplicate).toBe(false);
    const [evt] = await tdb.select().from(integrationEventsTable).where(eq(integrationEventsTable.activityId, a.body.activityId));
    expect(evt!.externalId).toMatch(/^sha256:/);
  });

  it("dedupes an id-less retry whose only difference is delivery metadata", async () => {
    const base = { first_name: "Retry", last_name: "Meta", phone: "5125550444", disposition: "answered" };
    const a = await withHeaderSecret({ ...base, timestamp: "2026-09-26T10:00:00Z", attempt: 1, delivery_id: "d-1" });
    const b = await withHeaderSecret({ ...base, timestamp: "2026-09-26T10:05:00Z", attempt: 2, delivery_id: "d-2" });
    expect(a.body.duplicate).toBe(false);
    expect(b.body).toEqual({ ok: true, duplicate: true });
  });

  it("does not read a generic 'date' field as the call start", async () => {
    const res = await withHeaderSecret({ call_id: "date-1", first_name: "Date", last_name: "Field", date: "2019-04-20" });
    const [a] = await tdb.select().from(activitiesTable).where(eq(activitiesTable.id, res.body.activityId));
    expect((a!.metadata as { startedAt: unknown }).startedAt).toBeNull();
  });

  it("rejects +json media types instead of failing their signature confusingly", async () => {
    const res = await request(app).post(url()).set("X-Webhook-Secret", SECRET).set("Content-Type", "application/vnd.enrollhere+json")
      .send(JSON.stringify({ call_id: "vnd-1", first_name: "V", last_name: "Nd" }));
    expect(res.status).toBe(415);
  });

  it("never stores the agent's email (user_email / rep_email) as the contact's", async () => {
    const res = await withHeaderSecret({ call_id: "ue-1", first_name: "Bob", last_name: "Beneficiary", phone: "5125550100", user_email: "closer@agency.example" });
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res.body.contactId));
    expect(c).toMatchObject({ email: null, assignedAgentId: agent.id });
    const res2 = await withHeaderSecret({ call_id: "re-1", first_name: "Rae", last_name: "Beneficiary", rep_email: "closer@agency.example", rep_phone: "5125559999" });
    const [c2] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res2.body.contactId));
    expect(c2).toMatchObject({ email: null, phone: null, assignedAgentId: agent.id });
  });

  it("ignores a 'caller' block's phone regardless of JSON key order", async () => {
    const raw = '{"caller":{"phone":"18005550000","name":"Support Line"},"first_name":"Top","last_name":"Levelbug","phone":"5125550555","call_id":"ord-1"}';
    const res = await request(app).post(url()).set("X-Webhook-Secret", SECRET).set("Content-Type", "application/json").send(raw);
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, res.body.contactId));
    expect(c!.phone).toBe("+15125550555");
  });
});

describe("integration_events prune", () => {
  it("deletes ledger rows older than the retention window only", async () => {
    const { integrationEventsPruneWorker } = await import("../../workers/integrationEventsPrune");
    await tdb.insert(integrationEventsTable).values([
      { id: "old-evt", orgId: org.id, source: "enrollhere", externalId: "old-1", receivedAt: new Date(Date.now() - 100 * 86_400_000) },
      { id: "new-evt", orgId: org.id, source: "enrollhere", externalId: "new-1" },
    ]);
    await integrationEventsPruneWorker();
    const ids = (await tdb.select().from(integrationEventsTable)).map((r) => r.id);
    expect(ids).not.toContain("old-evt");
    expect(ids).toContain("new-evt");
  });
});

describe("header recognition for compound address columns (CSV and webhook)", () => {
  it("maps address_* / mailing_* parts to their own fields and keeps street variants on address1", async () => {
    const { suggestContactField } = await import("../../lib/contactImport");
    const cases: Record<string, string> = {
      address_city: "city", address_state: "stateCode", address_zip: "zipCode", address_county: "county",
      "Mailing ZIP": "zipCode", "Mailing City": "city", "Mailing State": "stateCode",
      address: "address1", address1: "address1", "Address Line 1": "address1", street: "address1", "Street Address": "address1",
      "Address Line 2": "",
    };
    for (const [header, field] of Object.entries(cases)) expect([header, suggestContactField(header)]).toEqual([header, field]);
  });
});
