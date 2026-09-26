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
      const cfg2 = ({ orgId: org2.id, token: TOKEN, locationId: `loc-${org2.id}` });
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

  it("full re-sync requests made during a run collapse into one re-sync, started when the run ends", async () => {
    const org9 = await seedOrg(tdb, { id: "ghl-org-9" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org9.id}`;
    process.env.GHL_LOCATION_ID_GHL_ORG_9 = "loc-org-9";
    try {
      const { ghlSyncWorker } = await import("../../workers/ghlSync");
      const cfg9 = sync.ghlConfigFor(org9.id)!;
      const store9 = [ghlContact(9101), ghlContact(9102)];
      expect((await sync.runGhlSync(cfg9, { fetchImpl: fakeGhl(store9).impl })).status).toBe("ok");

      // Another run holds the lease; the admin clicks "Re-sync everything" three times.
      await tdb.update(ghlSyncStateTable).set({ runningSince: new Date(), leaseToken: "busy" }).where(eq(ghlSyncStateTable.orgId, org9.id));
      clearEnqueuedJobs();
      for (let k = 0; k < 3; k++) await ghlSyncWorker({ orgId: org9.id, full: true });
      expect(getEnqueuedJobs().filter((j) => (j.data as { orgId?: string }).orgId === org9.id)).toEqual([]);
      const [flagged] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org9.id));
      expect(flagged!.fullResyncRequestedAt).not.toBeNull();
      expect(flagged!.cursorUpdatedAt).not.toBeNull(); // not reset under the active run

      // The next run to start does the re-sync from the top, once.
      await tdb.update(ghlSyncStateTable).set({ runningSince: null, leaseToken: null }).where(eq(ghlSyncStateTable.orgId, org9.id));
      const ghl = fakeGhl(store9);
      expect((await sync.runGhlSync(cfg9, { fetchImpl: ghl.impl })).status).toBe("ok");
      expect(ghl.calls[0]!.body.filters).toBeUndefined();
      const [done] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org9.id));
      expect(done!.fullResyncRequestedAt).toBeNull();

      // A request that lands while a run is mid-flight makes that run report
      // more work, so the worker starts the re-sync straight away.
      const flagMidRun = (async (u: string, init: RequestInit) => {
        await sync.requestFullResync(cfg9);
        return fakeGhl(store9).impl(u, init);
      }) as unknown as typeof fetch;
      expect((await sync.runGhlSync(cfg9, { fetchImpl: flagMidRun })).status).toBe("more_pending");
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
      delete process.env.GHL_LOCATION_ID_GHL_ORG_9;
    }
  });

  it("does not erase a link's GHL timestamp when a later response has none", async () => {
    const [before] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-1"));
    expect(before!.externalUpdatedAt).not.toBeNull();
    const undated = (async () => new Response(JSON.stringify({ contacts: [{ ...ghlContact(1), dateUpdated: null }] }), { status: 200 })) as unknown as typeof fetch;
    await sync.runGhlSync(cfg(), { fetchImpl: undated });
    const [after] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-1"));
    expect(after!.externalUpdatedAt).toEqual(before!.externalUpdatedAt);
  });

  it("never updates or re-flags a contact deleted in agencyBRIDGE", async () => {
    const [link] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-10"));
    await tdb.update(contactsTable).set({ deletedAt: new Date(), city: null, optOutSms: false, optOutEmail: false }).where(eq(contactsTable.id, link!.contactId!));
    const r = await sync.runGhlSync(cfg(), { fetchImpl: fakeGhl([{ ...ghlContact(10), city: "Somewhere-New", dnd: true, dateUpdated: "2026-04-01T00:00:00.000Z" }]).impl });
    expect(r.skipped).toBe(1);
    const [c] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, link!.contactId!));
    expect(c).toMatchObject({ city: null, optOutSms: false, optOutEmail: false });
    expect(c!.deletedAt).not.toBeNull();
  });

  it("without a searchAfter from GHL, pages by number only within one shared timestamp", async () => {
    const org4 = await seedOrg(tdb, { id: "ghl-org-4" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org4.id}`;
    try {
      const cfg4 = ({ orgId: org4.id, token: TOKEN, locationId: `loc-${org4.id}` });
      const ghl = fakeGhl(Array.from({ length: 450 }, (_, k) => ghlContact(7000 + k, { dateUpdated: "2026-08-15T12:00:00.000Z" })), undefined, true);
      const statuses: string[] = [];
      for (let run = 0; run < 3; run++) statuses.push((await sync.runGhlSync(cfg4, { fetchImpl: ghl.impl, maxPages: 2 })).status);
      expect(statuses).toEqual(["more_pending", "more_pending", "ok"]);
      // Page 1 moves the filter up to the shared timestamp (and re-reads it
      // once); from there the only way forward is by page number.
      expect(ghl.calls.map((c) => [c.body.filters?.[0]?.value?.gte ?? null, c.body.page])).toEqual([
        [null, 1],
        ["2026-08-15T12:00:00.000Z", 1], ["2026-08-15T12:00:00.000Z", 2],
        ["2026-08-15T12:00:00.000Z", 3], ["2026-08-15T12:00:00.000Z", 4], ["2026-08-15T12:00:00.000Z", 5],
      ]);
      const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org4.id));
      expect(links).toHaveLength(450);
      const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org4.id));
      expect(state!.cursorSearchAfter).toBeNull();
      expect(state!.cursorUpdatedAt!.toISOString()).toBe("2026-08-15T12:00:00.000Z");
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("skips a contact that fails to save instead of stalling the feed, and tolerates non-string tags", async () => {
    const org7 = await seedOrg(tdb, { id: "ghl-org-7" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org7.id}`;
    try {
      const cfg7 = ({ orgId: org7.id, token: TOKEN, locationId: `loc-${org7.id}` });
      const ghl = fakeGhl([
        ghlContact(8001, { tags: [42 as unknown as string, " vip ", null as unknown as string] }),
        // Postgres rejects NUL in text: this contact cannot be written.
        ghlContact(8002, { firstName: "Bad\u0000Name" }),
        ghlContact(8003),
      ]);
      const res = await sync.runGhlSync(cfg7, { fetchImpl: ghl.impl });
      expect(res).toMatchObject({ status: "ok", created: 2, failed: 1 });
      const contacts = await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org7.id));
      expect(contacts.map((c) => c.firstName).sort()).toEqual(["First8001", "First8003"]);
      expect(contacts.find((c) => c.firstName === "First8001")!.tags).toEqual(["vip"]);
      const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org7.id));
      expect(state!.cursorUpdatedAt!.toISOString()).toBe(ghlContact(8003).dateUpdated);
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("without a searchAfter, a contact edited in GHL between runs does not shift a page and skip another", async () => {
    const org8 = await seedOrg(tdb, { id: "ghl-org-8" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org8.id}`;
    try {
      const cfg8 = ({ orgId: org8.id, token: TOKEN, locationId: `loc-${org8.id}` });
      const store = Array.from({ length: 250 }, (_, k) => ghlContact(9000 + k));
      const ghl = fakeGhl(store, undefined, true);
      expect((await sync.runGhlSync(cfg8, { fetchImpl: ghl.impl, maxPages: 1 })).status).toBe("more_pending");
      // An early contact is edited: it moves to the end, and a fixed-filter
      // page 2 would now start one contact later than before.
      store[5] = { ...store[5]!, email: "edited@example.com", dateUpdated: "2026-12-31T00:00:00.000Z" };
      let status = "";
      for (let run = 0; run < 10 && status !== "ok"; run++) status = (await sync.runGhlSync(cfg8, { fetchImpl: ghl.impl, maxPages: 1 })).status;
      expect(status).toBe("ok");
      const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org8.id));
      expect(new Set(links.map((l) => l.externalId)).size).toBe(250);
      const edited = (await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org8.id))).find((c) => c.firstName === "First9005")!;
      expect(edited.email).toBe("edited@example.com");
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("keeps going past many contacts with bad data, reports them as failed, and clears GHL's tuple when the window ends", async () => {
    const org10 = await seedOrg(tdb, { id: "ghl-org-10" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org10.id}`;
    try {
      const cfg10 = ({ orgId: org10.id, token: TOKEN, locationId: `loc-${org10.id}` });
      const bad = Array.from({ length: 7 }, (_, k) => ghlContact(9300 + k, { firstName: "Bad\u0000" + k }));
      const res = await sync.runGhlSync(cfg10, { fetchImpl: fakeGhl([...bad, ghlContact(9399)]).impl });
      expect(res).toMatchObject({ status: "ok", created: 1, failed: 7 });
      const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org10.id));
      expect(state).toMatchObject({ lastRunFailed: 7, cursorSearchAfter: null });
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("a weak name + birth-date match to a deleted contact doesn't block a different person", async () => {
    const org11 = await seedOrg(tdb, { id: "ghl-org-11" });
    const cfg11 = ({ orgId: org11.id, token: TOKEN, locationId: `loc-${org11.id}` });
    const dob = new Date("1950-03-07T00:00:00.000Z");
    const deleted = await seedContact(tdb, { orgId: org11.id, firstName: "John", lastName: "Smithers", email: "old-john@example.com", dob });
    await tdb.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, deleted.id));
    const r = await sync.runGhlSync(cfg11, { fetchImpl: fakeGhl([ghlContact(9401, {
      firstName: "John", lastName: "Smithers", email: "new-john@example.com", dateOfBirth: "1950-03-07T00:00:00.000Z",
    })]).impl });
    expect(r.created).toBe(1);
    const live = (await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org11.id))).filter((c) => !c.deletedAt);
    expect(live).toHaveLength(1);
    expect(live[0]!.email).toBe("new-john@example.com");
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
      const cfg5 = ({ orgId: org5.id, token: TOKEN, locationId: `loc-${org5.id}` });
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

  it("recovers when GHL stops sending searchAfter mid-window instead of stalling on page numbers", async () => {
    const org6 = await seedOrg(tdb, { id: "ghl-org-6" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org6.id}`;
    try {
      const cfg6 = ({ orgId: org6.id, token: TOKEN, locationId: `loc-${org6.id}` });
      const all = Array.from({ length: 250 }, (_, k) => ghlContact(11000 + k, { dateUpdated: new Date(Date.UTC(2026, 9, 1, 0, 0, k)).toISOString() }));
      // Tuples on the first page only, then GHL "forgets" them.
      let call = 0;
      const base = fakeGhl(all);
      const flaky = (async (u: string, init: RequestInit) => {
        const res = await base.impl(u, init);
        const json = await res.json() as { contacts: GhlContact[] };
        if (call++ > 0) json.contacts = json.contacts.map(({ searchAfter: _drop, ...c }) => c);
        return new Response(JSON.stringify(json), { status: 200 });
      }) as unknown as typeof fetch;
      await sync.runGhlSync(cfg6, { fetchImpl: flaky, maxPages: 2 });
      const [mid] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org6.id));
      expect(mid!.cursorSearchAfter).toBeNull(); // no stale page number
      // New contacts arriving later are still fetched.
      const later = [...all, ...Array.from({ length: 5 }, (_, k) => ghlContact(12000 + k, { dateUpdated: "2026-11-01T00:00:00.000Z" }))];
      for (let run = 0; run < 3; run++) await sync.runGhlSync(cfg6, { fetchImpl: fakeGhl(later).impl, maxPages: 5 });
      const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org6.id));
      expect(links).toHaveLength(255);
      const [end] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org6.id));
      expect(end!.cursorUpdatedAt!.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    } finally {
      process.env.GHL_SYNC_ORG_IDS = org.id;
    }
  });

  it("does not recreate a person the agency soft-deleted, even when their GHL record was never linked", async () => {
    const dob = new Date("1948-02-02T00:00:00.000Z");
    const gone = await seedContact(tdb, { orgId: org.id, firstName: "Gone", lastName: "Person", email: "gone@example.com", dob });
    await tdb.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, gone.id));
    const r = await sync.runGhlSync(cfg(), { fetchImpl: fakeGhl([ghlContact(13000, { firstName: "Gone", lastName: "Person", email: "gone@example.com", dateOfBirth: "1948-02-02T00:00:00.000Z", dateUpdated: "2026-12-01T00:00:00.000Z" })]).impl });
    expect(r).toMatchObject({ created: 0, skipped: 1 });
    expect((await orgContacts()).filter((c) => c.lastName === "Person" && !c.deletedAt)).toHaveLength(0);
    const [link] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-13000"));
    expect(link!.contactId).toBe(gone.id); // tombstone: later syncs stay skipped
  });

  it("holds (without binding) a GHL contact that only shares a household email + name with a deleted contact", async () => {
    const org12 = await seedOrg(tdb, { id: "ghl-org-12" });
    const cfg12 = ({ orgId: org12.id, token: TOKEN, locationId: `loc-${org12.id}` });
    const grandma = await seedContact(tdb, { orgId: org12.id, firstName: "Mary", lastName: "Johnson", email: "johnsons@example.com" });
    await tdb.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, grandma.id));
    const r = await sync.runGhlSync(cfg12, { fetchImpl: fakeGhl([ghlContact(13100, { firstName: "Mary", lastName: "Johnson", email: "johnsons@example.com" })]).impl });
    expect(r).toMatchObject({ created: 0, skipped: 1 });
    // Not recreated, and not permanently bound to the deleted grandmother either.
    const links = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.orgId, org12.id));
    expect(links).toHaveLength(0);
  });

  it("does not apply GHL DND to a household relative matched only by shared phone + name", async () => {
    const org13 = await seedOrg(tdb, { id: "ghl-org-13" });
    const cfg13 = ({ orgId: org13.id, token: TOKEN, locationId: `loc-${org13.id}` });
    const sr = await seedContact(tdb, { orgId: org13.id, firstName: "Bob", lastName: "Anderson", email: null });
    await tdb.update(contactsTable).set({ phone: "+15125557777", optOutSms: false, optOutEmail: false }).where(eq(contactsTable.id, sr.id));
    await sync.runGhlSync(cfg13, { fetchImpl: fakeGhl([ghlContact(13200, { firstName: "Bob", lastName: "Anderson", phone: "+15125557777", dnd: true })]).impl });
    const [after] = await tdb.select().from(contactsTable).where(eq(contactsTable.id, sr.id));
    expect(after).toMatchObject({ optOutSms: false, optOutEmail: false });
  });

  it("ignores an unparseable GHL dateUpdated instead of failing the contact", async () => {
    const org14 = await seedOrg(tdb, { id: "ghl-org-14" });
    const cfg14 = ({ orgId: org14.id, token: TOKEN, locationId: `loc-${org14.id}` });
    const bad = Array.from({ length: 6 }, (_, k) => ({ ...ghlContact(13300 + k), dateUpdated: "not-a-valid-date" }));
    const undated = (async () => new Response(JSON.stringify({ contacts: bad }), { status: 200 })) as unknown as typeof fetch;
    const r1 = await sync.runGhlSync(cfg14, { fetchImpl: undated });
    expect(r1).toMatchObject({ status: "ok", created: 6, failed: 0 });
    const r2 = await sync.runGhlSync(cfg14, { fetchImpl: undated }); // linked path
    expect(r2).toMatchObject({ status: "ok", updated: 6, failed: 0 });
  });

  it("does not recreate a hard-deleted contact (link survives as a tombstone)", async () => {
    const [link] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-11"));
    await tdb.delete(contactsTable).where(eq(contactsTable.id, link!.contactId!));
    const before = (await orgContacts()).length;
    const r = await sync.runGhlSync(cfg(), { fetchImpl: fakeGhl([{ ...ghlContact(11), dateUpdated: "2026-12-02T00:00:00.000Z" }]).impl });
    expect(r.skipped).toBe(1);
    expect((await orgContacts()).length).toBe(before);
    const [after] = await tdb.select().from(externalContactLinksTable).where(eq(externalContactLinksTable.externalId, "ghl-11"));
    expect(after!.contactId).toBeNull();
  });

  it("gets past a bulk edit where more contacts share one timestamp than fit in a run", async () => {
    const org3 = await seedOrg(tdb, { id: "ghl-org-3" });
    process.env.GHL_SYNC_ORG_IDS = `${org.id},${org3.id}`;
    try {
      const cfg3 = ({ orgId: org3.id, token: TOKEN, locationId: `loc-${org3.id}` });
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
    expect(res.body).toMatchObject({ queued: true, full: true, alreadyRunning: false });
    const [state] = await tdb.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, org.id));
    expect(state!.fullResyncRequestedAt).not.toBeNull();
    await tdb.update(ghlSyncStateTable).set({ fullResyncRequestedAt: null }).where(eq(ghlSyncStateTable.orgId, org.id));
  });

  it("tells the admin when a sync is already running", async () => {
    await tdb.update(ghlSyncStateTable).set({ runningSince: new Date(), leaseToken: "busy" }).where(eq(ghlSyncStateTable.orgId, org.id));
    try {
      const res = await request(app).post("/api/integrations/ghl/sync").set(withAuth(admin.id)).send({});
      expect(res.body).toMatchObject({ queued: true, full: false, alreadyRunning: true });
      // A lease left by a crashed run (older than the lease window) doesn't count.
      await tdb.update(ghlSyncStateTable).set({ runningSince: new Date(Date.now() - 45 * 60_000) }).where(eq(ghlSyncStateTable.orgId, org.id));
      const stale = await request(app).post("/api/integrations/ghl/sync").set(withAuth(admin.id)).send({});
      expect(stale.body).toMatchObject({ alreadyRunning: false });
    } finally {
      await tdb.update(ghlSyncStateTable).set({ runningSince: null, leaseToken: null }).where(eq(ghlSyncStateTable.orgId, org.id));
    }
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

describe("GHL multi-agency config safety", () => {
  const snapshot = () => ({ ...process.env });
  it("refuses orgs that would read the same GHL location, and orgs whose ids collide as env suffixes", async () => {
    const saved = snapshot();
    try {
      // Two orgs, only the global token/location set → both would read one sub-account.
      process.env.GHL_SYNC_ORG_IDS = "agency-a,agency-b";
      expect(sync.ghlConfigs()).toEqual([]);
      expect(sync.ghlConfigFor("agency-a")).toBeNull();

      // Distinct per-org locations → both allowed.
      process.env.GHL_LOCATION_ID_AGENCY_A = "loc-a";
      process.env.GHL_LOCATION_ID_AGENCY_B = "loc-b";
      expect(sync.ghlConfigs().map((c) => [c.orgId, c.locationId])).toEqual([["agency-a", "loc-a"], ["agency-b", "loc-b"]]);

      // "org-1" and "ORG_1" share the suffix ORG_1 → both refused.
      process.env.GHL_SYNC_ORG_IDS = "org-1,ORG_1";
      process.env.GHL_LOCATION_ID_ORG_1 = "loc-1";
      expect(sync.ghlConfigs()).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("GHL client resilience", () => {
  it("retries thrown network errors and honours an HTTP-date Retry-After", async () => {
    const { searchContacts, parseRetryAfterMs } = await import("../../lib/integrations/ghl/client");
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfterMs("soon")).toBeNull();
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = (async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed: TLS reset");
        return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
      }) as unknown as typeof fetch;
      const p = searchContacts({ token: TOKEN, locationId: LOCATION, updatedSince: null }, flaky);
      await vi.runAllTimersAsync();
      await expect(p).resolves.toMatchObject({ contacts: [] });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still backs off when Retry-After is a date in the past", async () => {
    const { searchContacts } = await import("../../lib/integrations/ghl/client");
    vi.useFakeTimers();
    try {
      const times: number[] = [];
      const limited = (async () => { times.push(Date.now()); return new Response("", { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2020 07:28:00 GMT" } }); }) as unknown as typeof fetch;
      const p = searchContacts({ token: TOKEN, locationId: LOCATION, updatedSince: null }, limited).catch((e: Error) => e);
      await vi.runAllTimersAsync();
      expect(await p).toBeInstanceOf(Error);
      expect(times.length).toBe(4);
      expect(times[3]! - times[0]!).toBeGreaterThanOrEqual(2000 + 4000 + 8000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the run at exactly a 60s Retry-After too", async () => {
    const { searchContacts } = await import("../../lib/integrations/ghl/client");
    let calls = 0;
    const limited = (async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "60" } }); }) as unknown as typeof fetch;
    await expect(searchContacts({ token: TOKEN, locationId: LOCATION, updatedSince: null }, limited)).rejects.toThrow(/retry after 60s/);
    expect(calls).toBe(1);
  });

  it("never puts database parameters (contact PHI) into the admin-visible error", () => {
    const err = Object.assign(new Error('Failed query: update "external_contact_links" set "x"=$1\nparams: bob.smith@example.com,+15125550999'), {});
    const msg = sync.safeErrorMessage(err);
    expect(msg).not.toMatch(/bob|5125550999/);
    expect(sync.safeErrorMessage(new Error("GHL contacts search failed: HTTP 401"))).toBe("GHL contacts search failed: HTTP 401");
  });

  it("ends the run on a long Retry-After instead of burning retries", async () => {
    const { searchContacts } = await import("../../lib/integrations/ghl/client");
    let calls = 0;
    const limited = (async () => {
      calls++;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
    }) as unknown as typeof fetch;
    await expect(searchContacts({ token: TOKEN, locationId: LOCATION, updatedSince: null }, limited))
      .rejects.toThrow(/retry after 3600s/);
    expect(calls).toBe(1);
  });
});
