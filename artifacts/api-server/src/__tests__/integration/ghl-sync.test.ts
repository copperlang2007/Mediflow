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
function fakeGhl(store: GhlContact[], pageLimitOverride?: number, omitSearchAfter = false) {
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
    const contacts = sorted.slice(start, start + limit)
      .map((c) => (omitSearchAfter ? { ...c } : { ...c, searchAfter: [Date.parse(c.dateUpdated!), c.id] }));
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
    // A proxy error page that echoes the request back, token included.
    const failing = (async () => new Response(`Invalid JWT. Received: Authorization: Bearer ${TOKEN}`, { status: 401 })) as unknown as typeof fetch;
    await expect(sync.runGhlSync(cfg(), { fetchImpl: failing })).rejects.toThrow(/HTTP 401.*contacts.readonly/);
    const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    expect(state).toMatchObject({ lastStatus: "error", runningSince: null });
    expect(state!.lastError).not.toContain(TOKEN);
  });

  it("a run whose lease was taken over stops without touching state (fencing)", async () => {
    const [before] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    const ghl = fakeGhl(store);
    const hijack = (async (url: string, init: RequestInit) => {
      // While this run is fetching, a newer run takes the lease over.
      await tdb.update(ghlSyncStateTable).set({ leaseToken: "newer-run", runningSince: new Date() }).where(eq(ghlSyncStateTable.orgId, org.id));
      return ghl.impl(url, init);
    }) as unknown as typeof fetch;
    const result = await sync.runGhlSync(cfg(), { fetchImpl: hijack });
    expect(result.status).toBe("already_running");
    const [after] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    expect(after).toMatchObject({ leaseToken: "newer-run", lastStatus: before!.lastStatus });
    expect(after!.cursorUpdatedAt).toEqual(before!.cursorUpdatedAt);
    await tdb.update(ghlSyncStateTable).set({ leaseToken: null, runningSince: null }).where(eq(ghlSyncStateTable.orgId, org.id));
  });

  it("a full re-sync requested while a run is active does not reset the cursor", async () => {
    await tdb.update(ghlSyncStateTable).set({ runningSince: new Date(), leaseToken: "busy" }).where(eq(ghlSyncStateTable.orgId, org.id));
    const [before] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    const r = await sync.runGhlSync(cfg(), { fetchImpl: fakeGhl(store).impl, full: true });
    expect(r.status).toBe("already_running");
    const [after] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    expect(after!.cursorUpdatedAt).toEqual(before!.cursorUpdatedAt);
    expect(after!.backfillCompletedAt).toEqual(before!.backfillCompletedAt);
    await tdb.update(ghlSyncStateTable).set({ leaseToken: null, runningSince: null }).where(eq(ghlSyncStateTable.orgId, org.id));
  });

  it("never updates or re-flags a contact deleted in agencyBRIDGE", async () => {
    const [link] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-10"));
    await tdb.update(contactsTable).set({ deletedAt: new Date(), city: null, optOutSms: false, optOutEmail: false }).where(eq(contactsTable.id, link!.contactId));
    const r = await sync.runGhlSync(cfg(), { fetchImpl: fakeGhl([{ ...ghlContact(10), city: "Somewhere-New", dnd: true, dateUpdated: "2026-04-01T00:00:00.000Z" }]).impl });
    expect(r.skipped).toBe(1);
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, link!.contactId));
    expect(c).toMatchObject({ city: null, optOutSms: false, optOutEmail: false });
    expect(c!.deletedAt).not.toBeNull();
  });

  it("without a searchAfter from GHL, continues by page number instead of restarting at page 1", async () => {
    const org4 = await seedOrg(tdb, { id: "ghl-org-4" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org4.id}`;
    try {
      const cfg4 = sync.ghlConfigFor(org4.id)!;
      const ghl = fakeGhl(Array.from({ length: 450 }, (_, k) => ghlContact(7000 + k, { dateUpdated: "2026-08-15T12:00:00.000Z" })), undefined, true);
      const statuses: string[] = [];
      for (let run = 0; run < 3; run++) statuses.push((await sync.runGhlSync(cfg4, { fetchImpl: ghl.impl, maxPages: 2 })).status);
      expect(statuses).toEqual(["more_pending", "more_pending", "ok"]);
      expect(ghl.calls.map((c) => c.body.page)).toEqual([1, 2, 3, 4, 5]);
      const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org4.id));
      expect(links).toHaveLength(450);
      const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org4.id));
      expect(state!.cursorSearchAfter).toBeNull();
      expect(state!.cursorUpdatedAt!.toISOString()).toBe("2026-08-15T12:00:00.000Z");
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("does not fuse a second GHL contact onto a contact already linked to another GHL id", async () => {
    // ghl-1 is already linked to First1 (email one@example.com). A different
    // GHL record for the same person must not be merged into it too.
    const before = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org.id));
    const r = await sync.runGhlSync(cfg(), { fetchImpl: fakeGhl([{ ...ghlContact(1), id: "ghl-dup-of-1", email: "one@example.com", city: "Elsewhere", dateUpdated: "2026-05-01T00:00:00.000Z" }]).impl });
    expect(r.skipped).toBe(1);
    const after = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org.id));
    expect(after).toHaveLength(before.length);
    expect((await orgContacts()).find((c) => c.firstName === "First1")!.city).toBe("Dallas"); // merge rolled back
  });

  it("keeps GHL's paging tuple when a page has no usable dateUpdated", async () => {
    const org5 = await seedOrg(tdb, { id: "ghl-org-5" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org5.id}`;
    try {
      const cfg5 = sync.ghlConfigFor(org5.id)!;
      const undated = Array.from({ length: 3 }, (_, k) => ({ ...ghlContact(9000 + k), dateUpdated: null }));
      const impl = (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const contacts = body.searchAfter ? [] : undated.map((c) => ({ ...c, searchAfter: [0, c.id] }));
        return new Response(JSON.stringify({ contacts }), { status: 200 });
      }) as unknown as typeof fetch;
      await sync.runGhlSync(cfg5, { fetchImpl: impl });
      const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org5.id));
      expect(state!.cursorSearchAfter).toEqual([0, "ghl-9002"]);
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("gets past a bulk edit where more contacts share one timestamp than fit in a run", async () => {
    const org3 = await seedOrg(tdb, { id: "ghl-org-3" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org3.id}`;
    try {
      const cfg3 = sync.ghlConfigFor(org3.id)!;
      const sameTs = "2026-08-01T00:00:00.000Z";
      const ghl = fakeGhl(Array.from({ length: 250 }, (_, k) => ghlContact(5000 + k, { dateUpdated: sameTs })));
      const statuses: string[] = [];
      for (let run = 0; run < 3; run++) statuses.push((await sync.runGhlSync(cfg3, { fetchImpl: ghl.impl, maxPages: 1 })).status);
      expect(statuses).toEqual(["more_pending", "more_pending", "ok"]);
      // Each continuation resumes with the persisted tuple, not from page 1.
      expect(ghl.calls[1]!.body.searchAfter).toEqual([Date.parse(sameTs), "ghl-5099"]);
      const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org3.id));
      expect(links).toHaveLength(250);
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });
});

describe("GHL admin endpoints", () => {
  it("reports status without exposing the token", async () => {
    const res = await request(app).get("/api/integrations/ghl/status").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, locationId: LOCATION, running: false });
    expect(res.body.lastRunAt).not.toBeNull();
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

describe("GHL client", () => {
  it("prefers a response-level searchAfter and falls back to the last contact's", async () => {
    const { searchContacts } = await import("../../lib/integrations/ghl/client");
    const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const base = { token: TOKEN, locationId: LOCATION, updatedSince: null };
    const top = await searchContacts(base, reply({ contacts: [{ id: "a", searchAfter: [1, "a"] }], searchAfter: [9, "z"] }));
    expect(top.searchAfter).toEqual([9, "z"]);
    const perContact = await searchContacts(base, reply({ contacts: [{ id: "a", searchAfter: [1, "a"] }] }));
    expect(perContact.searchAfter).toEqual([1, "a"]);
  });
});
