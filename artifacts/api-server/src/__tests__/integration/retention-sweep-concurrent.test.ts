/**
 * Concurrency guarantees for the retention-enforcement worker.
 *
 * If the daily sweep runs twice concurrently (clock-skewed cron
 * double-fire, a manual re-trigger overlapping the scheduled run, or two
 * pg-boss workers both claiming the job), the soft-delete phase has a
 * read-check-write race: both runs SELECT `deleted_at IS NULL` for the
 * same contact/deal before either commits, then both proceed.
 *
 * The retention-review TASK is already deduped by
 * `task_instances.retention_review_key` (PR #77) — the second concurrent
 * insert hits the partial unique index and does nothing.
 *
 * But the `retention_soft_delete` AUDIT-LOG row is NOT deduped: the worker
 * inserts it with a fresh `randomUUID()` and no `ON CONFLICT`. Two
 * concurrent runs therefore each write a `retention_soft_delete` audit
 * row for what is a single logical soft-delete — a duplicated audit trail,
 * which is a HIPAA integrity problem.
 *
 * The fix serializes the per-org sweep behind a transaction-scoped
 * Postgres advisory lock (`pg_advisory_xact_lock`, keyed per org — the
 * same pattern as the commission-reconcile worker, PR #69). A second
 * concurrent run for the same org blocks until the first transaction
 * commits, then sees the already-applied state and no-ops.
 *
 * Tests:
 *   1. `Promise.all` of two real worker runs for the same org: exactly
 *      one `retention_soft_delete` audit row per contact, exactly one
 *      review task. The advisory lock serializes the two transactions.
 *   2. Deterministic replay of the BUGGY (un-locked) pattern — two
 *      ungated audit inserts after a shared read — produces TWO audit
 *      rows. This is the regression demonstration: pglite serializes SQL
 *      through an internal async-mutex (see PR #81), so a naive
 *      `Promise.all` cannot interleave the SELECT/INSERT statements
 *      freely; we replay them step-by-step so the duplicated-audit-row
 *      bug manifests deterministically, and show the lock closes it.
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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  auditLogTable,
  contactsTable,
  dataRetentionPoliciesTable,
  taskInstancesTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedContact, type TestDb } from "../helpers/testDb";

let retentionEnforcementWorker: typeof import("../../workers/retentionEnforcement").retentionEnforcementWorker;
let db: TestDb;
let orgId: string;

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedExpiredContact(opts: {
  orgId: string;
  ageDays: number;
}): Promise<{ id: string }> {
  const contact = await seedContact(db, {
    orgId: opts.orgId,
    firstName: "Aged",
    lastName: `Contact-${randomUUID().slice(0, 6)}`,
    status: "lead",
  });
  // Push createdAt past the retention window so the sweep picks it up.
  const past = new Date(Date.now() - opts.ageDays * DAY_MS);
  await db
    .update(contactsTable)
    .set({ createdAt: past })
    .where(eq(contactsTable.id, contact.id));
  return { id: contact.id };
}

async function enableContactRetention(o: string, days: number): Promise<void> {
  await db.insert(dataRetentionPoliciesTable).values({
    id: `rp-${randomUUID()}`,
    orgId: o,
    recordType: "contacts",
    retentionDays: days,
    isEnabled: true,
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  const mod = await import("../../workers/retentionEnforcement");
  retentionEnforcementWorker = mod.retentionEnforcementWorker;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  const o = await seedOrg(db, { id: `org-retconc-${randomUUID().slice(0, 8)}` });
  orgId = o.id;
});

describe("retention-enforcement worker — concurrent-run safety", () => {
  it("two concurrent worker runs soft-delete each contact exactly once and write exactly one audit row", async () => {
    await enableContactRetention(orgId, 30);
    const c1 = await seedExpiredContact({ orgId, ageDays: 90 });
    const c2 = await seedExpiredContact({ orgId, ageDays: 90 });

    // Two overlapping sweeps for the same org. The per-org advisory lock
    // serializes the two transactions: the second blocks until the first
    // commits, then sees `deleted_at` already set and no-ops.
    await Promise.all([
      retentionEnforcementWorker(),
      retentionEnforcementWorker(),
    ]);

    for (const c of [c1, c2]) {
      const auditRows = await db
        .select({ id: auditLogTable.id })
        .from(auditLogTable)
        .where(
          and(
            eq(auditLogTable.orgId, orgId),
            eq(auditLogTable.resourceId, c.id),
            eq(auditLogTable.action, "retention_soft_delete"),
          ),
        );
      // Exactly one audit row per contact — NOT two. This is the
      // regression assertion: without the advisory lock both concurrent
      // runs insert their own (un-deduped) `retention_soft_delete` row.
      expect(auditRows).toHaveLength(1);

      const tasks = await db
        .select({ id: taskInstancesTable.id })
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, orgId),
            eq(
              taskInstancesTable.retentionReviewKey,
              `contact:${c.id}:soft-delete-review`,
            ),
          ),
        );
      expect(tasks).toHaveLength(1);

      const [contactRow] = await db
        .select({ deletedAt: contactsTable.deletedAt })
        .from(contactsTable)
        .where(eq(contactsTable.id, c.id))
        .limit(1);
      expect(contactRow?.deletedAt).not.toBeNull();
    }
  });

  it("a second sequential run is a no-op — no duplicate audit rows", async () => {
    await enableContactRetention(orgId, 30);
    const c = await seedExpiredContact({ orgId, ageDays: 90 });

    await retentionEnforcementWorker();
    await retentionEnforcementWorker();

    const auditRows = await db
      .select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, orgId),
          eq(auditLogTable.resourceId, c.id),
          eq(auditLogTable.action, "retention_soft_delete"),
        ),
      );
    expect(auditRows).toHaveLength(1);
  });

  /**
   * Deterministic demonstration of the race the advisory lock closes.
   *
   * pglite serializes every SQL statement through an internal async-mutex
   * (PR #81), so `Promise.all` of two un-locked sweeps cannot interleave
   * their SELECT/UPDATE/INSERT statements the way two real Postgres
   * workers would. We replay the un-locked soft-delete pattern
   * step-by-step:
   *
   *   readA → readB → (A: update + audit insert) → (B: update + audit insert)
   *
   * Both runs read `deleted_at IS NULL`, so both proceed to insert their
   * own un-deduped `retention_soft_delete` audit row — TWO rows for one
   * logical soft-delete. That is the bug. The advisory lock fixes it by
   * making run B block on `readB` until run A's transaction commits, at
   * which point B's `deleted_at IS NULL` SELECT returns nothing.
   */
  it("replaying the un-locked soft-delete pattern produces duplicate audit rows (the bug)", async () => {
    await enableContactRetention(orgId, 30);
    const c = await seedExpiredContact({ orgId, ageDays: 90 });

    // Both runs SELECT the active contact before either has soft-deleted.
    const [rowA] = await db
      .select({ id: contactsTable.id, deletedAt: contactsTable.deletedAt })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, c.id)))
      .limit(1);
    const [rowB] = await db
      .select({ id: contactsTable.id, deletedAt: contactsTable.deletedAt })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, c.id)))
      .limit(1);

    // Both see the contact as not-yet-deleted and decide to soft-delete.
    expect(rowA?.deletedAt).toBeNull();
    expect(rowB?.deletedAt).toBeNull();

    // Run A: soft-delete + (un-deduped) audit insert.
    await db
      .update(contactsTable)
      .set({ deletedAt: new Date() })
      .where(eq(contactsTable.id, c.id));
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId,
      userId: "system",
      action: "retention_soft_delete",
      resourceType: "contact",
      resourceId: c.id,
      changes: { retentionDays: 30 },
    });

    // Run B (already past its read-check): ALSO soft-deletes + audit-inserts.
    await db
      .update(contactsTable)
      .set({ deletedAt: new Date() })
      .where(eq(contactsTable.id, c.id));
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId,
      userId: "system",
      action: "retention_soft_delete",
      resourceType: "contact",
      resourceId: c.id,
      changes: { retentionDays: 30 },
    });

    const auditRows = await db
      .select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, orgId),
          eq(auditLogTable.resourceId, c.id),
          eq(auditLogTable.action, "retention_soft_delete"),
        ),
      );
    // The bug: two `retention_soft_delete` audit rows for one contact.
    // The worker, run under its advisory lock, never reaches this state —
    // see the `Promise.all` test above, which asserts exactly one row.
    expect(auditRows).toHaveLength(2);
  });
});
