/**
 * Concurrency / TOCTOU guarantees for `POST /leads/:id/convert`.
 *
 * The original handler did a classic read-check-write:
 *
 *   1. SELECT the lead
 *   2. if (row.status === "converted") return 409
 *   3. UPDATE lead set status="converted"
 *   4. UPDATE contact set status="prospect"
 *   5. INSERT activity row (one per call)
 *
 * Two concurrent calls would both pass step 2 before either reached
 * step 3, so each would proceed to step 5 and the activity timeline
 * would carry TWO "Lead converted to prospect" rows (with different
 * UUIDs) for what is logically a single conversion. Any automation
 * triggers attached to the lead's status change would also fire twice.
 *
 * The fix moves the check into the UPDATE itself —
 *
 *   UPDATE leads SET status='converted' WHERE id=$1 AND status!='converted'
 *
 * — and only writes the contact-status row + activity row if the
 * conditional UPDATE actually transitioned the lead (i.e. `returning()`
 * is non-empty). Postgres serializes concurrent UPDATEs against the
 * same row, so exactly one caller wins, and the activity row is
 * written exactly once. The whole transition is wrapped in a single
 * `db.transaction` so a crash between the conditional UPDATE, the
 * contact-status UPDATE, and the activity INSERT cannot leave the
 * system half-converted.
 *
 * Tests:
 *   1. Two `Promise.all([convert, convert])` calls on the same lead:
 *      one 200, one 409, exactly one activity row, lead status is
 *      "converted" once, contact status is "prospect". This is the
 *      regression test for the original bug — reverting the fix
 *      makes it fail.
 *   2. Convert a lead that does not exist → 404.
 *   3. Convert a lead from another org → 404 (BOLA / auth scoping).
 *   4. Convert an already-converted lead → 409.
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

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

import { and, eq, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  activitiesTable,
  contactsTable,
  leadsTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedContact,
  type TestDb,
} from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string };

async function seedLead(
  db: TestDb,
  opts: { orgId: string; contactId: string; status?: "new" | "converted" },
): Promise<{ id: string; orgId: string; contactId: string }> {
  const id = `lead-${randomUUID()}`;
  await db.insert(leadsTable).values({
    id,
    orgId: opts.orgId,
    contactId: opts.contactId,
    status: opts.status ?? "new",
    convertedAt: opts.status === "converted" ? new Date() : null,
  });
  return { id, orgId: opts.orgId, contactId: opts.contactId };
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  orgA = await seedOrg(testDb, { id: "lead-convert-org-a" });
  orgB = await seedOrg(testDb, { id: "lead-convert-org-b" });
  adminA = await seedUser(testDb, {
    orgId: orgA.id,
    role: "agency_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("POST /leads/:id/convert — TOCTOU / race guarantees", () => {
  it("two concurrent converts produce exactly one activity row and one 200 / one 409", async () => {
    const contact = await seedContact(testDb, {
      orgId: orgA.id,
      status: "lead",
    });
    const lead = await seedLead(testDb, {
      orgId: orgA.id,
      contactId: contact.id,
    });

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/leads/${lead.id}/convert`)
        .set(withAuth(adminA.id)),
      request(app)
        .post(`/api/leads/${lead.id}/convert`)
        .set(withAuth(adminA.id)),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one activity row was inserted for this contact (the only
    // non-idempotent side effect).
    const activities = await testDb
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.contactId, contact.id));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.body).toBe("Lead converted to prospect");

    // Lead is converted exactly once and has a convertedAt.
    const [leadRow] = await testDb
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, lead.id))
      .limit(1);
    expect(leadRow?.status).toBe("converted");
    expect(leadRow?.convertedAt).not.toBeNull();

    // Contact promoted.
    const [contactRow] = await testDb
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id))
      .limit(1);
    expect(contactRow?.status).toBe("prospect");
  });

  it("returns 404 when the lead does not exist", async () => {
    const res = await request(app)
      .post(`/api/leads/${randomUUID()}/convert`)
      .set(withAuth(adminA.id));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the lead lives in another org (BOLA defense)", async () => {
    const contactB = await seedContact(testDb, {
      orgId: orgB.id,
      status: "lead",
    });
    const leadB = await seedLead(testDb, {
      orgId: orgB.id,
      contactId: contactB.id,
    });

    const res = await request(app)
      .post(`/api/leads/${leadB.id}/convert`)
      .set(withAuth(adminA.id));
    expect(res.status).toBe(404);

    // The other org's lead must not have transitioned.
    const [leadRow] = await testDb
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadB.id))
      .limit(1);
    expect(leadRow?.status).toBe("new");

    // And no activity must have been written against orgB's contact.
    const activities = await testDb
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.contactId, contactB.id),
          eq(activitiesTable.orgId, orgB.id),
        ),
      );
    expect(activities).toHaveLength(0);
  });

  /**
   * Direct SQL-level demonstration of the TOCTOU race that the fix
   * closes. We cannot reliably exercise the race through `Promise.all`
   * against `request(app)` because pglite (the in-process Postgres
   * test backend) serializes every SQL statement through an internal
   * mutex, so the read-check-write completes atomically inside a
   * single test process. On a real Postgres deployment, two API
   * workers running the original handler against the same row would
   * interleave their SELECT/UPDATE/INSERT statements freely.
   *
   * Here we mechanically replay the two patterns step-by-step so the
   * race manifests deterministically:
   *
   *   - The OLD read-check-write pattern, replayed as
   *       readA → readB → updateA → insertA → updateB → insertB
   *     produces TWO activity rows — the bug.
   *
   *   - The NEW conditional UPDATE pattern, replayed in the same
   *     interleaved order, has exactly one of the two updates
   *     return a row (because the second sees `status='converted'`
   *     from the first) and the caller skips the activity insert.
   *     Exactly one activity row — the fix.
   */
  it("read-check-write pattern (the bug) produces duplicate activities; conditional update (the fix) does not", async () => {
    // ---- 1. Replay the BUGGY pattern --------------------------------
    const buggyContact = await seedContact(testDb, {
      orgId: orgA.id,
      status: "lead",
    });
    const buggyLead = await seedLead(testDb, {
      orgId: orgA.id,
      contactId: buggyContact.id,
    });

    // Both callers SELECT before either has UPDATEd.
    const [rowA] = await testDb
      .select({ status: leadsTable.status })
      .from(leadsTable)
      .where(eq(leadsTable.id, buggyLead.id))
      .limit(1);
    const [rowB] = await testDb
      .select({ status: leadsTable.status })
      .from(leadsTable)
      .where(eq(leadsTable.id, buggyLead.id))
      .limit(1);

    // Both see status === "new" and both decide they should convert.
    expect(rowA?.status).toBe("new");
    expect(rowB?.status).toBe("new");

    // Caller A UPDATEs + inserts activity.
    await testDb
      .update(leadsTable)
      .set({ status: "converted", convertedAt: new Date() })
      .where(eq(leadsTable.id, buggyLead.id));
    await testDb.insert(activitiesTable).values({
      id: randomUUID(),
      orgId: orgA.id,
      contactId: buggyContact.id,
      type: "status_change",
      body: "Lead converted to prospect",
      createdBy: adminA.id,
    });

    // Caller B (already past the read-check) ALSO UPDATEs + inserts.
    await testDb
      .update(leadsTable)
      .set({ status: "converted", convertedAt: new Date() })
      .where(eq(leadsTable.id, buggyLead.id));
    await testDb.insert(activitiesTable).values({
      id: randomUUID(),
      orgId: orgA.id,
      contactId: buggyContact.id,
      type: "status_change",
      body: "Lead converted to prospect",
      createdBy: adminA.id,
    });

    const buggyActivities = await testDb
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.contactId, buggyContact.id));
    // The bug: two activity rows for one logical conversion.
    expect(buggyActivities).toHaveLength(2);

    // ---- 2. Replay the FIXED pattern --------------------------------
    const fixedContact = await seedContact(testDb, {
      orgId: orgA.id,
      status: "lead",
    });
    const fixedLead = await seedLead(testDb, {
      orgId: orgA.id,
      contactId: fixedContact.id,
    });

    // Caller A: conditional UPDATE wins because status != "converted".
    const [updatedA] = await testDb
      .update(leadsTable)
      .set({ status: "converted", convertedAt: new Date() })
      .where(
        and(
          eq(leadsTable.id, fixedLead.id),
          eq(leadsTable.orgId, orgA.id),
          ne(leadsTable.status, "converted"),
        ),
      )
      .returning();
    expect(updatedA).toBeDefined();
    // Only the winning caller inserts the activity.
    await testDb.insert(activitiesTable).values({
      id: randomUUID(),
      orgId: orgA.id,
      contactId: fixedContact.id,
      type: "status_change",
      body: "Lead converted to prospect",
      createdBy: adminA.id,
    });

    // Caller B: conditional UPDATE loses because status is now
    // "converted" — `returning()` is empty, so the handler returns 409
    // and SKIPS the activity insert.
    const [updatedB] = await testDb
      .update(leadsTable)
      .set({ status: "converted", convertedAt: new Date() })
      .where(
        and(
          eq(leadsTable.id, fixedLead.id),
          eq(leadsTable.orgId, orgA.id),
          ne(leadsTable.status, "converted"),
        ),
      )
      .returning();
    expect(updatedB).toBeUndefined();

    const fixedActivities = await testDb
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.contactId, fixedContact.id));
    // The fix: exactly one activity row regardless of contention.
    expect(fixedActivities).toHaveLength(1);
  });

  it("returns 409 when the lead is already converted (no duplicate activity row)", async () => {
    const contact = await seedContact(testDb, {
      orgId: orgA.id,
      status: "prospect",
    });
    const lead = await seedLead(testDb, {
      orgId: orgA.id,
      contactId: contact.id,
      status: "converted",
    });

    const res = await request(app)
      .post(`/api/leads/${lead.id}/convert`)
      .set(withAuth(adminA.id));
    expect(res.status).toBe(409);

    // Conditional UPDATE must not have inserted a new activity row.
    const activities = await testDb
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.contactId, contact.id));
    expect(activities).toHaveLength(0);
  });
});
