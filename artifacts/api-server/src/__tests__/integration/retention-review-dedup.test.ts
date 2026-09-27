/**
 * Integration test: retention-review task dedup is keyed by
 * (orgId, entityType, entityId, phase) — NOT by title.
 *
 * Before the fix, the retention-enforcement worker checked
 * `WHERE title = ? AND status = 'open'` to decide whether to skip a
 * review task. Two agents in the same org with identical
 * first/last names rendered identical titles, so the second agent
 * never got a review task. When a reviewer closed the first task,
 * the next sweep proceeded to hard-delete BOTH agents — only one had
 * actually been reviewed. That is a HIPAA compliance gap (the audit
 * trail attributes the deletion of agent B to a review that was
 * really about agent A).
 *
 * Migration 0011 added a `retention_review_key` text column and a
 * partial unique index on `(org_id, retention_review_key)
 * WHERE retention_review_key IS NOT NULL`. The worker now sets
 * the key to `${entityType}:${entityId}:${phase}` and uses
 * `ON CONFLICT DO NOTHING` against that index, so:
 *   1. Two agents with the same name each get their own review task.
 *   2. A second worker run is a no-op (no duplicate piling on).
 *   3. The same entity in a different phase (soft-delete vs
 *      hard-delete) still gets a distinct review task.
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

import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  dataRetentionPoliciesTable,
  agentsTable,
  taskInstancesTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent, type TestDb } from "../helpers/testDb";
import { CMS_RECORD_RETENTION_DAYS } from "../../lib/compliance/retention";

let retentionEnforcementWorker: typeof import("../../workers/retentionEnforcement").retentionEnforcementWorker;
let db: TestDb;
let orgId: string;

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedAgedAgent(opts: {
  orgId: string;
  firstName: string;
  lastName: string;
  ageDays: number;
  id?: string;
}): Promise<{ id: string }> {
  const { id } = await seedAgent(db, {
    id: opts.id ?? `agent-${randomUUID()}`,
    orgId: opts.orgId,
    firstName: opts.firstName,
    lastName: opts.lastName,
    email: `${opts.firstName}.${opts.lastName}.${randomUUID().slice(0, 6)}@agency.example`,
  });
  // Push createdAt past the retention window so the worker picks it up.
  const past = new Date(Date.now() - opts.ageDays * DAY_MS);
  await db
    .update(agentsTable)
    .set({ createdAt: past })
    .where(eq(agentsTable.id, id));
  return { id };
}

async function enableAgentRetention(o: string, days: number): Promise<void> {
  await db.insert(dataRetentionPoliciesTable).values({
    id: `rp-${randomUUID()}`,
    orgId: o,
    recordType: "agents",
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
  // Fresh org per test keeps the partial unique index assertions clean
  // — the index is keyed on (org_id, retention_review_key).
  const o = await seedOrg(db, { id: `org-retdedup-${randomUUID().slice(0, 8)}` });
  orgId = o.id;
});

describe("retention-review task dedup (HIPAA)", () => {
  it("two agents with identical names in the same org each get their own review task", async () => {
    await enableAgentRetention(orgId, CMS_RECORD_RETENTION_DAYS);

    const a = await seedAgedAgent({
      orgId,
      firstName: "John",
      lastName: "Smith",
      ageDays: CMS_RECORD_RETENTION_DAYS + 30,
    });
    const b = await seedAgedAgent({
      orgId,
      firstName: "John",
      lastName: "Smith",
      ageDays: CMS_RECORD_RETENTION_DAYS + 30,
    });

    expect(a.id).not.toBe(b.id);

    await retentionEnforcementWorker();

    const tasks = await db
      .select({
        id: taskInstancesTable.id,
        title: taskInstancesTable.title,
        retentionReviewKey: taskInstancesTable.retentionReviewKey,
      })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, orgId));

    // Pre-fix: only one task created (the second insert was skipped by
    // the title-keyed dedup), and BOTH agents were eligible for hard
    // delete on the next sweep. Post-fix: one task per agent, each with
    // a distinct retention_review_key.
    expect(tasks).toHaveLength(2);
    const keys = tasks.map((t) => t.retentionReviewKey).sort();
    expect(keys).toEqual(
      [
        `agent:${a.id}:soft-delete-review`,
        `agent:${b.id}:soft-delete-review`,
      ].sort(),
    );
    // Human-readable title is preserved (operator-facing); just not
    // load-bearing for dedup any more.
    for (const t of tasks) {
      expect(t.title).toBe('Retention review required: agent "John Smith"');
    }
  });

  it("worker is idempotent — a second run does not create duplicate tasks", async () => {
    await enableAgentRetention(orgId, CMS_RECORD_RETENTION_DAYS);
    await seedAgedAgent({
      orgId,
      firstName: "Alice",
      lastName: "Nguyen",
      ageDays: CMS_RECORD_RETENTION_DAYS + 60,
    });

    await retentionEnforcementWorker();
    await retentionEnforcementWorker();

    const tasks = await db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, orgId));

    expect(tasks).toHaveLength(1);
  });

  it("agents with distinct names each get their own task (no regression)", async () => {
    await enableAgentRetention(orgId, CMS_RECORD_RETENTION_DAYS);
    const a = await seedAgedAgent({
      orgId,
      firstName: "Alice",
      lastName: "Nguyen",
      ageDays: CMS_RECORD_RETENTION_DAYS + 30,
    });
    const b = await seedAgedAgent({
      orgId,
      firstName: "Bob",
      lastName: "Tran",
      ageDays: CMS_RECORD_RETENTION_DAYS + 30,
    });

    await retentionEnforcementWorker();

    const tasks = await db
      .select({
        retentionReviewKey: taskInstancesTable.retentionReviewKey,
      })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, orgId));

    expect(tasks).toHaveLength(2);
    const keys = tasks.map((t) => t.retentionReviewKey).sort();
    expect(keys).toEqual(
      [
        `agent:${a.id}:soft-delete-review`,
        `agent:${b.id}:soft-delete-review`,
      ].sort(),
    );
  });

  it("partial unique index permits different phases for the same entity", async () => {
    // Direct DB-level assertion: two distinct phases (soft- vs
    // hard-delete-review) for the same agent are NOT a key collision,
    // because the phase suffix differs. The agent-flow itself only
    // emits the soft-delete-review key today (hard delete is operator-
    // driven), so we exercise the partial unique index directly to
    // confirm the dedup key allows the multi-phase usage the worker's
    // contact/deal flows already rely on.
    const a = await seedAgedAgent({
      orgId,
      firstName: "Carol",
      lastName: "Lopez",
      ageDays: CMS_RECORD_RETENTION_DAYS + 30,
    });

    const k1 = `agent:${a.id}:soft-delete-review`;
    const k2 = `agent:${a.id}:hard-delete-review`;

    await db.insert(taskInstancesTable).values({
      id: randomUUID(),
      orgId,
      title: "phase 1",
      status: "open",
      priority: "medium",
      retentionReviewKey: k1,
    });

    // Same key → no-op (partial unique index fires).
    const reinsertSame = await db
      .insert(taskInstancesTable)
      .values({
        id: randomUUID(),
        orgId,
        title: "phase 1 again",
        status: "open",
        priority: "medium",
        retentionReviewKey: k1,
      })
      .onConflictDoNothing({
        target: [taskInstancesTable.orgId, taskInstancesTable.retentionReviewKey],
        // Match the partial unique index predicate so Postgres can
        // infer the arbiter index (`WHERE retention_review_key IS NOT NULL`).
        where: sql`${taskInstancesTable.retentionReviewKey} IS NOT NULL`,
      })
      .returning({ id: taskInstancesTable.id });
    expect(reinsertSame).toHaveLength(0);

    // Different phase → succeeds.
    await db.insert(taskInstancesTable).values({
      id: randomUUID(),
      orgId,
      title: "phase 2",
      status: "open",
      priority: "high",
      retentionReviewKey: k2,
    });

    const tasks = await db
      .select({ key: taskInstancesTable.retentionReviewKey })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, orgId));
    const keys = tasks.map((t) => t.key).filter((k): k is string => k !== null).sort();
    expect(keys).toContain(k1);
    expect(keys).toContain(k2);
    expect(keys.filter((k) => k === k1)).toHaveLength(1);
  });
});
