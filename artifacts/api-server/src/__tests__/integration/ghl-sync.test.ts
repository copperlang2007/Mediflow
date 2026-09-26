/**
 * GoHighLevel contact feed against pglite with a fake GHL API: request shape,
 * backfill, incremental pull, resume-after-cap, dedupe/link behavior, DND,
 * the run lease, error recording, and the admin endpoints.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

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

import { eq } from "drizzle-orm";
import { contactsTable, externalContactLinksTable, ghlSyncStateTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth, getEnqueuedJobs, clearEnqueuedJobs } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact, type TestDb } from "../helpers/testDb";
import type { GhlContact } from "../../lib/integrations/ghl/client";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let sync: typeof import("../../lib/integrations/ghl/sync");
let tdb: TestDb;
let org: { id: string };
let admin: { id: string };

const TOKEN = "pit-test-token-123";
const LOCATION = "loc-abc";

/** Fake GHL: serves `store` sorted by dateUpdated, honoring the gte filter and paging. */
function fakeGhl(store: GhlContact[], pageLimitOverride?: number) {
  const calls: { headers: Record<string, string>; body: Record<string, any> }[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ headers: init.headers as Record<string, string>, body });
    const gte = body.filters?.[0]?.value?.gte as string | undefined;
    const sorted = [...store]
      .filter((c) => !gte || c.dateUpdated! >= gte)
      .sort((a, b) => a.dateUpdated!.localeCompare(b.dateUpdated!) || a.id.localeCompare(b.id));
    const limit = pageLimitOverride ?? body.pageLimit;
    let start = 0;
    if (body.searchAfter) {
      const [ts, id] = body.searchAfter as [number, string];
      start = sorted.findIndex((c) => Date.parse(c.dateUpdated!) === ts && c.id === id) + 1;
    } else {
      start = ((body.page ?? 1) - 1) * limit;
    }
    const contacts = sorted.slice(start, start + limit).map((c) => ({ ...c, searchAfter: [Date.parse(c.dateUpdated!), c.id] }));
    return new Response(JSON.stringify({ contacts, total: sorted.length }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function ghlContact(i: number, extra: Partial<GhlContact> = {}): GhlContact {
  return {
    id: `ghl-${i}`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    phone: `+1512555${String(1000 + i)}`,
    dateUpdated: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    ...extra,
  };
}

beforeAll(async () => {
  const handle = await bootTestDb();
  tdb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  sync = await import("../../lib/integrations/ghl/sync");
  org = await seedOrg(tdb, { id: "ghl-org" });
  admin = await seedUser(tdb, { orgId: org.id, role: "agency_admin" });
  await seedContact(tdb, { orgId: org.id, firstName: "Betty", lastName: "Local", email: "betty@example.com" });
  process.env.GHL_SYNC_ORG_IDS = org.id;
  process.env.GHL_PRIVATE_INTEGRATION_TOKEN = TOKEN;
  process.env.GHL_LOCATION_ID = LOCATION;
});

afterAll(async () => {
  delete process.env.GHL_SYNC_ORG_IDS;
  delete process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
  delete process.env.GHL_LOCATION_ID;
  await shutdownTestDb();
});

beforeEach(() => clearEnqueuedJobs());

const cfg = () => sync.ghlConfigFor(org.id)!;
const orgContacts = () => tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org.id));

describe("GHL feed", () => {
  const store: GhlContact[] = [
    ghlContact(1, { email: "one@example.com", tags: ["aep-2026"], dateOfBirth: "1950-03-07T00:00:00.000Z", state: "TX", postalCode: "78701" }),
    ghlContact(2, { firstName: "Betty", lastName: "Local", email: "BETTY@example.com", phone: null, address1: "1 Elm", city: "Austin" }),
    ghlContact(3, { firstName: null, lastName: null, contactName: null }), // phone-only lead → skipped
    ghlContact(4, { dnd: true }),
    ...Array.from({ length: 6 }, (_, k) => ghlContact(10 + k)),
  ];

  it("backfill sends the documented request and creates/links contacts", async () => {
    const ghl = fakeGhl(store);
    const result = await sync.runGhlSync(cfg(), { fetchImpl: ghl.impl });
    expect(result).toMatchObject({ status: "ok", created: 8, updated: 1, skipped: 1 });

    const first = ghl.calls[0]!;
    expect(first.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28" });
    expect(first.body).toMatchObject({ locationId: LOCATION, sort: [{ field: "dateUpdated", direction: "asc" }] });
    expect(first.body.filters).toBeUndefined(); // backfill: no date filter

    const contacts = await orgContacts();
    const one = contacts.find((c) => c.firstName === "First1")!;
    expect(one).toMatchObject({ email: "one@example.com", stateCode: "TX", zipCode: "78701", leadSource: "GoHighLevel", tags: ["aep-2026"] });
    expect(one.dob!.toISOString().slice(0, 10)).toBe("1950-03-07");

    // Betty matched the existing local contact (email + first name): one Betty, blanks filled.
    const bettys = contacts.filter((c) => c.firstName === "Betty");
    expect(bettys).toHaveLength(1);
    expect(bettys[0]).toMatchObject({ address1: "1 Elm", city: "Austin", email: "betty@example.com" });

    expect(contacts.find((c) => c.firstName === "First4")).toMatchObject({ optOutSms: true, optOutEmail: true });
    const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org.id));
    expect(links).toHaveLength(9);

    const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    expect(state).toMatchObject({ lastStatus: "ok", runningSince: null, lastError: null });
    expect(state!.backfillCompletedAt).not.toBeNull();
    expect(state!.cursorUpdatedAt!.toISOString()).toBe(store[store.length - 1]!.dateUpdated);
  });

  it("incremental pull asks only for changes since the cursor and never duplicates", async () => {
    const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    const changed = { ...ghlContact(1), email: "one@example.com", city: "Dallas", dateUpdated: "2026-02-01T00:00:00.000Z" };
    const ghl = fakeGhl([...store.filter((c) => c.id !== "ghl-1"), changed]);
    const before = (await orgContacts()).length;

    const result = await sync.runGhlSync(cfg(), { fetchImpl: ghl.impl });
    expect(ghl.calls[0]!.body.filters).toEqual([
      { field: "dateUpdated", operator: "range", value: { gte: state!.cursorUpdatedAt!.toISOString() } },
    ]);
    expect(result.created).toBe(0);
    expect((await orgContacts()).length).toBe(before);
    const one = (await orgContacts()).find((c) => c.firstName === "First1")!;
    expect(one.city).toBe("Dallas"); // was blank → filled
  });

  it("DND in GHL turns opt-outs on for an existing contact, never off", async () => {
    const ghl = fakeGhl([{ ...ghlContact(1), email: "one@example.com", dnd: true, dateUpdated: "2026-03-01T00:00:00.000Z" }]);
    await sync.runGhlSync(cfg(), { fetchImpl: ghl.impl });
    expect((await orgContacts()).find((c) => c.firstName === "First1")).toMatchObject({ optOutSms: true, optOutEmail: true });
  });

  it("stops at the page cap, reports more_pending, and resumes from the cursor", async () => {
    const org2 = await seedOrg(tdb, { id: "ghl-org-2" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org2.id}`;
    try {
      const cfg2 = sync.ghlConfigFor(org2.id)!;
      const ghl = fakeGhl(Array.from({ length: 250 }, (_, k) =>
        ghlContact(1000 + k, { dateUpdated: new Date(Date.UTC(2026, 6, 1, 0, 0, k)).toISOString() })));
      const r1 = await sync.runGhlSync(cfg2, { fetchImpl: ghl.impl, maxPages: 2 });
      expect(r1).toMatchObject({ status: "more_pending", pages: 2, created: 200 });
      const r2 = await sync.runGhlSync(cfg2, { fetchImpl: ghl.impl, maxPages: 5 });
      expect(r2.status).toBe("ok");
      // Second run resumes from the last contact written (inclusive), not from the top.
      expect(ghl.calls[2]!.body.filters[0].value.gte).toBe(new Date(Date.UTC(2026, 6, 1, 0, 0, 199)).toISOString());
      const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org2.id));
      expect(links).toHaveLength(250);
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("does not run twice at once for the same org", async () => {
    await tdb.update(ghlSyncStateTable).set({ runningSince: new Date() }).where(eq(ghlSyncStateTable.orgId, org.id));
    const ghl = fakeGhl(store);
    expect((await sync.runGhlSync(cfg(), { fetchImpl: ghl.impl })).status).toBe("already_running");
    expect(ghl.calls).toHaveLength(0);
    await tdb.update(ghlSyncStateTable).set({ runningSince: null }).where(eq(ghlSyncStateTable.orgId, org.id));
  });

  it("records an auth failure without leaking the token, and releases the lease", async () => {
    const failing = (async () => new Response("Invalid JWT", { status: 401 })) as unknown as typeof fetch;
    await expect(sync.runGhlSync(cfg(), { fetchImpl: failing })).rejects.toThrow(/HTTP 401.*contacts.readonly/);
    const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    expect(state).toMatchObject({ lastStatus: "error", runningSince: null });
    expect(state!.lastError).not.toContain(TOKEN);
  });
});

describe("GHL admin endpoints", () => {
  it("reports status without exposing the token", async () => {
    const res = await request(app).get("/api/integrations/ghl/status").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, locationId: LOCATION, lastStatus: "error" });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it("queues a full backfill on request", async () => {
    const res = await request(app).post("/api/integrations/ghl/sync").set(withAuth(admin.id)).send({ full: true });
    expect(res.status).toBe(202);
    expect(getEnqueuedJobs()).toContainEqual({ name: "ghl-sync", data: { orgId: org.id, full: true } });
  });

  it("refuses when the agency isn't configured", async () => {
    const prev = process.env.GHL_SYNC_ORG_IDS;
    process.env.GHL_SYNC_ORG_IDS = "";
    try {
      const res = await request(app).post("/api/integrations/ghl/sync").set(withAuth(admin.id)).send({});
      expect(res.status).toBe(400);
    } finally {
      process.env.GHL_SYNC_ORG_IDS = prev;
    }
  });
});
