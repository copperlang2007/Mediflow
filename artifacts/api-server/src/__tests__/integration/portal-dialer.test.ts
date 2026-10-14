/**
 * stage2/portal-dialer — read-only composition endpoints behind the Client
 * Portal preview, Softphone desk, Supervisor desk and Quoting Engine pages.
 *
 * Each endpoint: auth required, permission gate, org scoping, happy path.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact, type TestDb } from "../helpers/testDb";
import * as schema from "@workspace/db/schema";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let db: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let support: { id: string };
let agentUser: { id: string };
let otherAdmin: { id: string };
let agent: { id: string };
let contact: { id: string };
let dncContact: { id: string };
let otherContact: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(db, { id: "pd-org" });
  otherOrg = await seedOrg(db, { id: "pd-other-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  support = await seedUser(db, { orgId: org.id, role: "agent_support" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });

  agent = await seedAgent(db, { orgId: org.id, firstName: "Sam", lastName: "Rivera" });
  await db.update(schema.agentsTable).set({ phone: "+15035550000" }).where(eq(schema.agentsTable.id, agent.id));

  contact = await seedContact(db, {
    orgId: org.id,
    firstName: "Joan",
    lastName: "Park",
    email: "joan@example.com",
    dob: new Date("1950-02-03"),
    medicareId: "1EG4TE5MK73",
    status: "enrolled",
  });
  await db
    .update(schema.contactsTable)
    .set({ phone: "(503) 555-1234", stateCode: "OR", zipCode: "97201", assignedAgentId: agent.id })
    .where(eq(schema.contactsTable.id, contact.id));

  dncContact = await seedContact(db, { orgId: org.id, firstName: "Dee", lastName: "Nc" });
  await db
    .update(schema.contactsTable)
    .set({ phone: "(503) 555-9999", stateCode: "OR" })
    .where(eq(schema.contactsTable.id, dncContact.id));
  // STOP recorded by Twilio in E.164 — must still match the formatted number.
  await db.insert(schema.optOutsTable).values({
    id: randomUUID(), orgId: org.id, phone: "+15035559999", channel: "sms",
  });

  otherContact = await seedContact(db, { orgId: otherOrg.id, firstName: "Other", lastName: "Org" });
  await db
    .update(schema.contactsTable)
    .set({ phone: "(503) 555-1234" })
    .where(eq(schema.contactsTable.id, otherContact.id));

  // Plan, messages, a document, a call log and a parsed call summary.
  const [carrier] = await db
    .insert(schema.carriersTable)
    .values({ id: randomUUID(), orgId: org.id, name: "Acme Health" })
    .returning();
  await db.insert(schema.enrollmentsTable).values({
    id: randomUUID(), orgId: org.id, contactId: contact.id, carrierId: carrier.id,
    agentId: agent.id, planName: "Acme Advantage", planType: "MAPD", planYear: 2026,
    effectiveDate: "2026-01-01", status: "active",
  });
  const threadId = randomUUID();
  await db.insert(schema.messageThreadsTable).values({
    id: threadId, orgId: org.id, contactId: contact.id, channel: "sms",
  });
  await db.insert(schema.messagesTable).values([
    { id: randomUUID(), threadId, direction: "outbound", body: "First", status: "sent", createdAt: new Date("2026-03-01T10:00:00Z") },
    { id: randomUUID(), threadId, direction: "inbound", body: "Second", status: "received", createdAt: new Date("2026-03-02T10:00:00Z") },
  ]);
  await db.insert(schema.documentsTable).values({
    id: randomUUID(), orgId: org.id, contactId: contact.id, name: "Scope of Appointment.pdf",
    category: "soa", storageKey: "/objects/soa",
  });
  await db.insert(schema.activitiesTable).values({
    id: randomUUID(), orgId: org.id, contactId: contact.id, type: "call_log",
    body: "Talked about renewal", metadata: { disposition: "FOLLOW_UP" }, createdBy: admin.id,
  });
  await db.insert(schema.dialTicketsTable).values({
    id: randomUUID(), orgId: org.id, contactRef: contact.id, agentId: agent.id, status: "COMPLETED",
    transcriptParsed: { summary: "Discussed plan options", suggestedDisposition: { code: null, category: "FOLLOW_UP", confidence: 0.7 }, riskFlags: [], actionItems: ["Send SOA"] } as never,
    transcriptParsedAt: new Date("2026-03-03T10:00:00Z"),
  });
  // Other org's parsed ticket, pointing at our contact id — must not leak.
  await db.insert(schema.dialTicketsTable).values({
    id: randomUUID(), orgId: otherOrg.id, contactRef: contact.id, status: "COMPLETED",
    transcriptParsed: { summary: "Cross-org", riskFlags: [], actionItems: [] } as never,
    transcriptParsedAt: new Date("2026-03-04T10:00:00Z"),
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /client-portal/preview/:contactId", () => {
  it("requires auth", async () => {
    const res = await request(app).get(`/api/client-portal/preview/${contact.id}`);
    expect(res.status).toBe(401);
  });

  it("requires contact:read (agent role -> 403)", async () => {
    const res = await request(app).get(`/api/client-portal/preview/${contact.id}`).set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("404s for another org's contact", async () => {
    const res = await request(app).get(`/api/client-portal/preview/${contact.id}`).set(withAuth(otherAdmin.id));
    expect(res.status).toBe(404);
  });

  it("returns plan, messages (oldest first), documents, agent and writes an audit row", async () => {
    const res = await request(app).get(`/api/client-portal/preview/${contact.id}`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.contact.firstName).toBe("Joan");
    // No MBI / DOB / health data in the preview payload at all.
    expect(res.body.contact.medicareId).toBeUndefined();
    expect(res.body.contact.dob).toBeUndefined();
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]).toMatchObject({ carrierName: "Acme Health", planName: "Acme Advantage", agentFirstName: "Sam" });
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(["First", "Second"]);
    expect(res.body.documents[0].name).toBe("Scope of Appointment.pdf");
    expect(res.body.documents[0].storageKey).toBeUndefined();
    expect(res.body.agent).toMatchObject({ firstName: "Sam", phone: "+15035550000" });
    expect(res.body.permissions).toEqual({ canReplySms: true, canReplyEmail: true });

    const audits = await db.select().from(schema.auditLogTable).where(and(
      eq(schema.auditLogTable.orgId, org.id),
      eq(schema.auditLogTable.action, "view_client_portal_preview"),
      eq(schema.auditLogTable.resourceId, contact.id),
    ));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].userId).toBe(admin.id);
  });
});

describe("GET /client-portal/preview — legacy plan fields", () => {
  it("falls back to the contact's own plan fields when no enrollment exists", async () => {
    const legacy = await seedContact(db, { orgId: org.id, firstName: "Lee", lastName: "Gacy" });
    const [carrier] = await db.insert(schema.carriersTable)
      .values({ id: randomUUID(), orgId: org.id, name: "Legacy Mutual" }).returning();
    await db.update(schema.contactsTable)
      .set({ currentPlanType: "PDP", currentCarrierId: carrier.id, planYear: 2026 })
      .where(eq(schema.contactsTable.id, legacy.id));
    const res = await request(app).get(`/api/client-portal/preview/${legacy.id}`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(0);
    expect(res.body.recordedPlan).toEqual({ planType: "PDP", planYear: 2026, carrierName: "Legacy Mutual" });
  });
});

describe("GET /softphone/lookup", () => {
  it("an unlinked agent fails closed (self-scoped softphone; see softphone-agent-scope.test.ts)", async () => {
    const res = await request(app).get("/api/softphone/lookup?phone=5035551234").set(withAuth(agentUser.id));
    expect(res.status).toBe(404);
  });

  it("validates the number", async () => {
    const res = await request(app).get("/api/softphone/lookup?phone=12").set(withAuth(admin.id));
    expect(res.status).toBe(400);
  });

  it("matches regardless of formatting and stays in the org", async () => {
    const res = await request(app).get("/api/softphone/lookup?phone=%2B1%20503-555-1234").set(withAuth(support.id));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toEqual([contact.id]);
  });
});

describe("GET /softphone/precheck", () => {
  it("an unlinked agent fails closed", async () => {
    const res = await request(app).get(`/api/softphone/precheck?contactId=${contact.id}`).set(withAuth(agentUser.id));
    expect(res.status).toBe(404);
  });

  it("404s across orgs", async () => {
    const res = await request(app).get(`/api/softphone/precheck?contactId=${contact.id}`).set(withAuth(otherAdmin.id));
    expect(res.status).toBe(404);
  });

  it("checks the assigned agent and reports licensing gaps", async () => {
    const res = await request(app).get(`/api/softphone/precheck?contactId=${contact.id}`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ id: agent.id, source: "assigned" });
    expect(res.body.okToCall).toBe(false);
    const codes = res.body.failures.map((f: { code: string }) => f.code);
    expect(codes).toContain("AGENT_NOT_LICENSED");
    expect(res.body.checks.dncClear).toBe(true);
    expect(res.body.callingHours.timezone).toBe("America/Los_Angeles");
  });

  it("flags DNC via the normalized opt-out number", async () => {
    const res = await request(app).get(`/api/softphone/precheck?contactId=${dncContact.id}`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.checks.dncClear).toBe(false);
    expect(res.body.okToCall).toBe(false);
  });

  it("rejects an agent from another org", async () => {
    const foreign = await seedAgent(db, { orgId: otherOrg.id });
    const res = await request(app)
      .get(`/api/softphone/precheck?contactId=${contact.id}&agentId=${foreign.id}`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });
});

describe("GET /softphone/recent-calls + /softphone/dispositions", () => {
  it("lists the org's call logs only", async () => {
    const res = await request(app).get("/api/softphone/recent-calls").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ contactId: contact.id, firstName: "Joan" });

    const other = await request(app).get("/api/softphone/recent-calls").set(withAuth(otherAdmin.id));
    expect(other.body.data).toHaveLength(0);
  });

  it("returns the disposition catalogue and is permission-gated", async () => {
    const res = await request(app).get("/api/softphone/dispositions").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { code: string }) => d.code)).toContain("FOLLOW_UP");
    const denied = await request(app).get("/api/softphone/dispositions").set(withAuth(agentUser.id));
    expect(denied.status).toBe(404);
  });
});

describe("GET /supervisor/call-summaries", () => {
  it("is supervisor-only (agent_support -> 403)", async () => {
    const res = await request(app).get("/api/supervisor/call-summaries").set(withAuth(support.id));
    expect(res.status).toBe(403);
  });

  it("returns this org's parsed summaries with names", async () => {
    const res = await request(app).get("/api/supervisor/call-summaries").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      summary: "Discussed plan options",
      contact: { id: contact.id, name: "Joan Park" },
      agent: { id: agent.id, name: "Sam Rivera" },
    });
  });

  it("does not leak across orgs", async () => {
    const res = await request(app).get("/api/supervisor/call-summaries").set(withAuth(otherAdmin.id));
    expect(res.status).toBe(200);
    // The other org's ticket points at a contact id that is not in its org.
    expect(res.body.data).toHaveLength(0);
  });
});

describe("GET /quoting/providers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("requires contact:read", async () => {
    const res = await request(app).get("/api/quoting/providers?lastName=smith").set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("validates input and never calls upstream on bad input", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await request(app).get("/api/quoting/providers?lastName=%3Cscript%3E").set(withAuth(admin.id));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps NPPES results", async () => {
    const spy = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      expect(u.hostname).toBe("npiregistry.cms.hhs.gov");
      expect(u.searchParams.get("last_name")).toBe("smith");
      expect(u.searchParams.get("state")).toBe("FL");
      return new Response(JSON.stringify({
        result_count: 1,
        results: [{
          number: 1234567890,
          basic: { first_name: "JANE", last_name: "SMITH", credential: "MD" },
          addresses: [{ address_purpose: "LOCATION", address_1: "1 MAIN ST", city: "MIAMI", state: "FL", postal_code: "331011234", telephone_number: "305-555-0100" }],
          taxonomies: [{ desc: "Family Medicine", primary: true }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await request(app).get("/api/quoting/providers?lastName=smith&state=fl").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ npi: "1234567890", name: "Jane Smith", specialty: "Family Medicine", city: "Miami", zip: "33101" });
  });

  it("returns 502 when upstream fails", async () => {
    globalThis.fetch = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const res = await request(app).get("/api/quoting/providers?lastName=smith").set(withAuth(admin.id));
    expect(res.status).toBe(502);
  });
});
