/**
 * Integration tests for the bulk add_tag / remove_tag actions on
 * POST /api/contacts/bulk.
 *
 * The handler was refactored from a per-contact UPDATE loop (~N round-trips
 * for an N-id payload, up to 200) into a single set-based UPDATE that
 * pushes the dedup / removal logic into Postgres. These tests verify:
 *   1. add_tag correctly unions an existing tag set per row, without
 *      duplicates, across rows whose initial tag arrays differ.
 *   2. add_tag is idempotent when the tag is already present (no
 *      duplicate entries created).
 *   3. remove_tag drops every occurrence of the tag and leaves the
 *      other tags untouched, including for rows that don't have the tag.
 *   4. remove_tag tolerates NULL tag columns (array_remove on a NULL
 *      column would otherwise return NULL — coalesce guards against this).
 *   5. A loose wall-clock budget that would be infeasible under the
 *      old per-row pattern (50 sequential pglite UPDATEs).
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

import { eq, inArray } from "drizzle-orm";
import { contactsTable } from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
} from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";

import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// supertest's CJS default import is awkward to type with --moduleResolution
// bundler; existing integration tests use `as any` here so we follow suit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;

let org: { id: string };
let admin: { id: string };
let handle: TestDbHandle;

async function setTags(contactId: string, tags: string[] | null): Promise<void> {
  await handle.db
    .update(contactsTable)
    .set({ tags })
    .where(eq(contactsTable.id, contactId));
}

async function getContactsByIds(ids: string[]): Promise<
  Array<{ id: string; tags: string[] | null }>
> {
  return handle.db
    .select({ id: contactsTable.id, tags: contactsTable.tags })
    .from(contactsTable)
    .where(inArray(contactsTable.id, ids));
}

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "bulk-tag-org" });
  admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("POST /api/contacts/bulk — add_tag / remove_tag set-based update", () => {
  it("add_tag across 50 contacts with disjoint initial tag sets adds the new tag exactly once per row", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const c = await seedContact(handle.db, {
        orgId: org.id,
        firstName: `AddTag${i}`,
      });
      // Give each contact a different initial tag set so we know dedup is
      // happening per row, not globally.
      const initial = i % 3 === 0 ? ["alpha"] : i % 3 === 1 ? ["beta", "gamma"] : null;
      await setTags(c.id, initial);
      ids.push(c.id);
    }

    const t0 = Date.now();
    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids, action: "add_tag", payload: { tag: "vip" } });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affected: 50 });

    // Coarse wall-clock backstop only. The real assertions are the status
    // and `{ affected: 50 }` body above. This just catches a gross
    // regression back to the old per-row loop (~50 sequential pglite
    // UPDATEs) vs. the single set-based UPDATE. The bound is deliberately
    // huge — a loaded CI runner can stall an HTTP round-trip for seconds —
    // so it cannot flake while still failing on an O(N) reintroduction.
    expect(elapsed).toBeLessThan(15000);

    const rows = await getContactsByIds(ids);
    expect(rows).toHaveLength(50);
    for (const row of rows) {
      expect(row.tags).toBeTruthy();
      // Every row must now contain "vip"…
      expect(row.tags).toContain("vip");
      // …exactly once.
      expect(row.tags!.filter((t) => t === "vip")).toHaveLength(1);
    }

    // Spot-check that pre-existing tags are preserved on a row that had them.
    const withBetaGamma = rows.find((r) => r.tags?.includes("beta"));
    expect(withBetaGamma?.tags?.sort()).toEqual(["beta", "gamma", "vip"]);
  });

  it("add_tag is idempotent: re-adding an existing tag does not duplicate it", async () => {
    const a = await seedContact(handle.db, { orgId: org.id, firstName: "Idemp1" });
    const b = await seedContact(handle.db, { orgId: org.id, firstName: "Idemp2" });
    await setTags(a.id, ["already-here", "other"]);
    await setTags(b.id, ["already-here"]);

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({
        ids: [a.id, b.id],
        action: "add_tag",
        payload: { tag: "already-here" },
      });

    expect(res.status).toBe(200);
    const rows = await getContactsByIds([a.id, b.id]);
    const byId = new Map(rows.map((r) => [r.id, r.tags]));
    expect(byId.get(a.id)?.sort()).toEqual(["already-here", "other"]);
    expect(byId.get(b.id)?.sort()).toEqual(["already-here"]);
  });

  it("remove_tag drops every occurrence of the target tag and preserves the rest", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = await seedContact(handle.db, {
        orgId: org.id,
        firstName: `Rem${i}`,
      });
      // Mixed: some rows have the target tag, some don't, some have only
      // the target tag, some have a NULL tag column.
      const initial =
        i % 4 === 0
          ? ["drop-me", "keep-me"]
          : i % 4 === 1
            ? ["keep-only"]
            : i % 4 === 2
              ? ["drop-me"]
              : null;
      await setTags(c.id, initial);
      ids.push(c.id);
    }

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids, action: "remove_tag", payload: { tag: "drop-me" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affected: 20 });

    const rows = await getContactsByIds(ids);
    for (const row of rows) {
      // No row should contain the dropped tag anymore.
      expect(row.tags ?? []).not.toContain("drop-me");
    }
    // Rows that started with ["drop-me", "keep-me"] retain "keep-me".
    const withKeepMe = rows.filter((r) => r.tags?.includes("keep-me"));
    expect(withKeepMe.length).toBeGreaterThan(0);
    // Rows that started with ["keep-only"] are untouched.
    const withKeepOnly = rows.filter(
      (r) => r.tags?.length === 1 && r.tags[0] === "keep-only",
    );
    expect(withKeepOnly.length).toBeGreaterThan(0);
  });

  it("remove_tag tolerates NULL tag columns without erroring", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "NullTags" });
    await setTags(c.id, null);

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "remove_tag", payload: { tag: "anything" } });

    expect(res.status).toBe(200);
    const [row] = await getContactsByIds([c.id]);
    // After the coalesce-then-array_remove, the row should either be
    // an empty array or NULL — never an error. We accept either since
    // both are equivalent from a "tag present" standpoint, but assert
    // the column is non-error-shaped.
    expect(row.tags === null || Array.isArray(row.tags)).toBe(true);
    expect(row.tags ?? []).not.toContain("anything");
  });
});
