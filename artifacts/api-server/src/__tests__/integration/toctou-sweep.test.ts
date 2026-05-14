/**
 * TOCTOU sweep — sibling patterns to the lead-convert race closed in
 * PR #81. Each of the four routes below previously had a classic
 * read-check-write race: read a row, compare a status/stage field in
 * JS, then unconditionally write and fire a status-change automation
 * trigger based on the stale comparison. Two concurrent requests both
 * saw the "pre" state and both proceeded — duplicating history rows,
 * automation trigger enqueues, and timestamp overwrites.
 *
 * The fix replaces each read-check-write with a conditional UPDATE
 * gated on the actual state transition (`WHERE status != newStatus`)
 * with `.returning()`. Only the caller whose UPDATE actually flipped
 * the row sees `returning()` non-empty, and only that caller fires the
 * side effect. The transition + history row + activity row commit
 * atomically inside a single `db.transaction`.
 *
 * Pglite caveat (mirroring `lead-convert-race.test.ts`): pglite
 * serializes every SQL statement through an internal mutex, so a
 * `Promise.all` against the un-fixed code does not actually interleave
 * the SELECT and UPDATE at the SQL layer. Each route therefore gets a
 * deterministic SQL-level interleave test that mechanically replays the
 * pre-fix pattern and shows it producing duplicate side effects, and
 * replays the post-fix conditional UPDATE and shows it producing
 * exactly one.
 *
 * Routes covered:
 *   - PATCH /leads/:id           (status transition + lead_status_changed)
 *   - PATCH /deals/:id           (stage transition + history + activity + deal_stage_changed)
 *   - PATCH /tasks/:id           (completion + completedAt + task_completed)
 *   - PATCH /sequences/:id/enrollments/:eid (cancel + completedAt)
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

import { and, eq, ne, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  activitiesTable,
  dealsTable,
  dealStageHistoryTable,
  leadsTable,
  pipelinesTable,
  pipelineStagesTable,
  sequencesTable,
  sequenceEnrollmentsTable,
  taskInstancesTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  clearEnqueuedJobs,
  getEnqueuedJobs,
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
let adminA: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  orgA = await seedOrg(testDb, { id: "toctou-sweep-org-a" });
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

// ============================================================================
// PATCH /leads/:id — status transition + lead_status_changed trigger
// ============================================================================

async function seedLeadRow(
  db: TestDb,
  opts: { orgId: string; contactId: string; status?: "new" | "contacted" | "qualified" | "converted" },
): Promise<{ id: string }> {
  const id = `lead-${randomUUID()}`;
  await db.insert(leadsTable).values({
    id,
    orgId: opts.orgId,
    contactId: opts.contactId,
    status: opts.status ?? "new",
  });
  return { id };
}

describe("PATCH /leads/:id — lead_status_changed TOCTOU", () => {
  it("two concurrent same-status PATCHes fire the trigger exactly once", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const lead = await seedLeadRow(testDb, { orgId: orgA.id, contactId: contact.id });

    const [a, b] = await Promise.all([
      request(app)
        .patch(`/api/leads/${lead.id}`)
        .set(withAuth(adminA.id))
        .send({ status: "qualified" }),
      request(app)
        .patch(`/api/leads/${lead.id}`)
        .set(withAuth(adminA.id))
        .send({ status: "qualified" }),
    ]);

    // Both PATCHes succeed (idempotent contract preserved).
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "lead_status_changed",
    );
    expect(enq).toHaveLength(1);
  });

  it("no-op same-status PATCH fires no trigger", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const lead = await seedLeadRow(testDb, {
      orgId: orgA.id,
      contactId: contact.id,
      status: "qualified",
    });

    const res = await request(app)
      .patch(`/api/leads/${lead.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "qualified" });
    expect(res.status).toBe(200);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "lead_status_changed",
    );
    expect(enq).toHaveLength(0);
  });

  it("distinct transitions fire the trigger once per real transition", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const lead = await seedLeadRow(testDb, { orgId: orgA.id, contactId: contact.id });

    await request(app)
      .patch(`/api/leads/${lead.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "contacted" });
    await request(app)
      .patch(`/api/leads/${lead.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "qualified" });

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "lead_status_changed",
    );
    expect(enq).toHaveLength(2);
  });

  it("PATCH that only changes non-status fields does not fire the trigger", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const lead = await seedLeadRow(testDb, { orgId: orgA.id, contactId: contact.id });

    const res = await request(app)
      .patch(`/api/leads/${lead.id}`)
      .set(withAuth(adminA.id))
      .send({ score: 42 });
    expect(res.status).toBe(200);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "lead_status_changed",
    );
    expect(enq).toHaveLength(0);
  });

  it("returns 404 for non-existent lead", async () => {
    const res = await request(app)
      .patch(`/api/leads/${randomUUID()}`)
      .set(withAuth(adminA.id))
      .send({ status: "qualified" });
    expect(res.status).toBe(404);
  });

  it("SQL-level replay: read-check-write produces duplicate trigger contexts; conditional update produces one", async () => {
    // BUGGY pattern: both callers SELECT before either has UPDATEd.
    const buggyContact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const buggyLead = await seedLeadRow(testDb, { orgId: orgA.id, contactId: buggyContact.id });
    const [rowA] = await testDb.select({ status: leadsTable.status }).from(leadsTable).where(eq(leadsTable.id, buggyLead.id)).limit(1);
    const [rowB] = await testDb.select({ status: leadsTable.status }).from(leadsTable).where(eq(leadsTable.id, buggyLead.id)).limit(1);
    expect(rowA?.status).toBe("new");
    expect(rowB?.status).toBe("new");
    // Both decide the transition is "new -> qualified" and BOTH would
    // fire the trigger.
    const buggyTriggerFires: Array<{ oldStatus: string; newStatus: string }> = [];
    await testDb.update(leadsTable).set({ status: "qualified" }).where(eq(leadsTable.id, buggyLead.id));
    if (rowA && rowA.status !== "qualified") buggyTriggerFires.push({ oldStatus: rowA.status, newStatus: "qualified" });
    await testDb.update(leadsTable).set({ status: "qualified" }).where(eq(leadsTable.id, buggyLead.id));
    if (rowB && rowB.status !== "qualified") buggyTriggerFires.push({ oldStatus: rowB.status, newStatus: "qualified" });
    expect(buggyTriggerFires).toHaveLength(2);

    // FIXED pattern: conditional UPDATE — second caller's `returning()`
    // is empty because the first transition already happened.
    const fixedContact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const fixedLead = await seedLeadRow(testDb, { orgId: orgA.id, contactId: fixedContact.id });
    const fixedFires: Array<{ oldStatus: string }> = [];
    const [updA] = await testDb
      .update(leadsTable)
      .set({ status: "qualified" })
      .where(and(eq(leadsTable.id, fixedLead.id), ne(leadsTable.status, "qualified")))
      .returning();
    if (updA) fixedFires.push({ oldStatus: "new" });
    const [updB] = await testDb
      .update(leadsTable)
      .set({ status: "qualified" })
      .where(and(eq(leadsTable.id, fixedLead.id), ne(leadsTable.status, "qualified")))
      .returning();
    if (updB) fixedFires.push({ oldStatus: "new" });
    expect(fixedFires).toHaveLength(1);
  });
});

// ============================================================================
// PATCH /deals/:id — stage transition + history + activity + deal_stage_changed
// ============================================================================

async function seedPipelineWithStages(
  db: TestDb,
  opts: { orgId: string },
): Promise<{ pipelineId: string; stageA: string; stageB: string }> {
  const pipelineId = `pipeline-${randomUUID()}`;
  await db.insert(pipelinesTable).values({
    id: pipelineId,
    orgId: opts.orgId,
    name: "Test pipeline",
  });
  const stageA = `stage-a-${randomUUID()}`;
  const stageB = `stage-b-${randomUUID()}`;
  await db.insert(pipelineStagesTable).values([
    { id: stageA, pipelineId, name: "A", orderIndex: 0 },
    { id: stageB, pipelineId, name: "B", orderIndex: 1 },
  ]);
  return { pipelineId, stageA, stageB };
}

async function seedDeal(
  db: TestDb,
  opts: { orgId: string; contactId: string; pipelineId: string; stageId: string },
): Promise<{ id: string }> {
  const id = `deal-${randomUUID()}`;
  await db.insert(dealsTable).values({
    id,
    orgId: opts.orgId,
    pipelineId: opts.pipelineId,
    stageId: opts.stageId,
    contactId: opts.contactId,
    title: "Test deal",
    status: "open",
  });
  return { id };
}

describe("PATCH /deals/:id — deal_stage_changed TOCTOU", () => {
  it("two concurrent same-stage moves write history+activity exactly once and fire trigger once", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const { pipelineId, stageA, stageB } = await seedPipelineWithStages(testDb, { orgId: orgA.id });
    const deal = await seedDeal(testDb, { orgId: orgA.id, contactId: contact.id, pipelineId, stageId: stageA });

    const [a, b] = await Promise.all([
      request(app)
        .patch(`/api/deals/${deal.id}`)
        .set(withAuth(adminA.id))
        .send({ stageId: stageB }),
      request(app)
        .patch(`/api/deals/${deal.id}`)
        .set(withAuth(adminA.id))
        .send({ stageId: stageB }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const history = await testDb
      .select()
      .from(dealStageHistoryTable)
      .where(eq(dealStageHistoryTable.dealId, deal.id));
    expect(history).toHaveLength(1);

    const activities = await testDb
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.dealId, deal.id));
    expect(activities).toHaveLength(1);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "deal_stage_changed",
    );
    expect(enq).toHaveLength(1);
  });

  it("no-op same-stage PATCH writes no history row and fires no trigger", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const { pipelineId, stageA } = await seedPipelineWithStages(testDb, { orgId: orgA.id });
    const deal = await seedDeal(testDb, { orgId: orgA.id, contactId: contact.id, pipelineId, stageId: stageA });

    const res = await request(app)
      .patch(`/api/deals/${deal.id}`)
      .set(withAuth(adminA.id))
      .send({ stageId: stageA });
    expect(res.status).toBe(200);

    const history = await testDb
      .select()
      .from(dealStageHistoryTable)
      .where(eq(dealStageHistoryTable.dealId, deal.id));
    expect(history).toHaveLength(0);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "deal_stage_changed",
    );
    expect(enq).toHaveLength(0);
  });

  it("PATCH with no stageId (title change only) does not write history or fire trigger", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const { pipelineId, stageA } = await seedPipelineWithStages(testDb, { orgId: orgA.id });
    const deal = await seedDeal(testDb, { orgId: orgA.id, contactId: contact.id, pipelineId, stageId: stageA });

    const res = await request(app)
      .patch(`/api/deals/${deal.id}`)
      .set(withAuth(adminA.id))
      .send({ title: "Renamed" });
    expect(res.status).toBe(200);

    const history = await testDb
      .select()
      .from(dealStageHistoryTable)
      .where(eq(dealStageHistoryTable.dealId, deal.id));
    expect(history).toHaveLength(0);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "deal_stage_changed",
    );
    expect(enq).toHaveLength(0);
  });

  it("returns 404 for non-existent deal", async () => {
    const res = await request(app)
      .patch(`/api/deals/${randomUUID()}`)
      .set(withAuth(adminA.id))
      .send({ title: "X" });
    expect(res.status).toBe(404);
  });

  it("SQL-level replay: read-check-write produces 2 history rows; conditional update produces 1", async () => {
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const { pipelineId, stageA, stageB } = await seedPipelineWithStages(testDb, { orgId: orgA.id });

    // BUGGY: both callers SELECT before either UPDATEs.
    const buggyDeal = await seedDeal(testDb, { orgId: orgA.id, contactId: contact.id, pipelineId, stageId: stageA });
    const [exA] = await testDb.select().from(dealsTable).where(eq(dealsTable.id, buggyDeal.id)).limit(1);
    const [exB] = await testDb.select().from(dealsTable).where(eq(dealsTable.id, buggyDeal.id)).limit(1);
    expect(exA?.stageId).toBe(stageA);
    expect(exB?.stageId).toBe(stageA);
    await testDb.update(dealsTable).set({ stageId: stageB }).where(eq(dealsTable.id, buggyDeal.id));
    if (exA && exA.stageId !== stageB) {
      await testDb.insert(dealStageHistoryTable).values({
        id: randomUUID(), dealId: buggyDeal.id, fromStageId: exA.stageId, toStageId: stageB, changedByUserId: adminA.id,
      });
    }
    await testDb.update(dealsTable).set({ stageId: stageB }).where(eq(dealsTable.id, buggyDeal.id));
    if (exB && exB.stageId !== stageB) {
      await testDb.insert(dealStageHistoryTable).values({
        id: randomUUID(), dealId: buggyDeal.id, fromStageId: exB.stageId, toStageId: stageB, changedByUserId: adminA.id,
      });
    }
    const buggyHistory = await testDb.select().from(dealStageHistoryTable).where(eq(dealStageHistoryTable.dealId, buggyDeal.id));
    expect(buggyHistory).toHaveLength(2);

    // FIXED: conditional UPDATE only one of N callers sees a row.
    const fixedDeal = await seedDeal(testDb, { orgId: orgA.id, contactId: contact.id, pipelineId, stageId: stageA });
    const [updA] = await testDb.update(dealsTable).set({ stageId: stageB }).where(and(eq(dealsTable.id, fixedDeal.id), ne(dealsTable.stageId, stageB))).returning();
    if (updA) {
      await testDb.insert(dealStageHistoryTable).values({
        id: randomUUID(), dealId: fixedDeal.id, fromStageId: stageA, toStageId: stageB, changedByUserId: adminA.id,
      });
    }
    const [updB] = await testDb.update(dealsTable).set({ stageId: stageB }).where(and(eq(dealsTable.id, fixedDeal.id), ne(dealsTable.stageId, stageB))).returning();
    if (updB) {
      await testDb.insert(dealStageHistoryTable).values({
        id: randomUUID(), dealId: fixedDeal.id, fromStageId: stageA, toStageId: stageB, changedByUserId: adminA.id,
      });
    }
    const fixedHistory = await testDb.select().from(dealStageHistoryTable).where(eq(dealStageHistoryTable.dealId, fixedDeal.id));
    expect(fixedHistory).toHaveLength(1);
  });
});

// ============================================================================
// PATCH /tasks/:id — task_completed TOCTOU
// ============================================================================

async function seedTask(
  db: TestDb,
  opts: { orgId: string; status?: "open" | "completed" },
): Promise<{ id: string }> {
  const id = `task-${randomUUID()}`;
  await db.insert(taskInstancesTable).values({
    id,
    orgId: opts.orgId,
    title: "Test task",
    status: opts.status ?? "open",
    priority: "medium",
  });
  return { id };
}

describe("PATCH /tasks/:id — task_completed TOCTOU", () => {
  it("two concurrent completes fire the trigger exactly once and write completedAt once", async () => {
    const task = await seedTask(testDb, { orgId: orgA.id });

    const [a, b] = await Promise.all([
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .set(withAuth(adminA.id))
        .send({ status: "completed" }),
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .set(withAuth(adminA.id))
        .send({ status: "completed" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "task_completed",
    );
    expect(enq).toHaveLength(1);

    const [row] = await testDb
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.id, task.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
  });

  it("re-completing an already-completed task fires no trigger and does not bump completedAt", async () => {
    const task = await seedTask(testDb, { orgId: orgA.id, status: "completed" });
    // Backfill a stable completedAt for the seed.
    const originalAt = new Date("2024-01-01T00:00:00Z");
    await testDb
      .update(taskInstancesTable)
      .set({ completedAt: originalAt })
      .where(eq(taskInstancesTable.id, task.id));

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "completed" });
    expect(res.status).toBe(200);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "task_completed",
    );
    expect(enq).toHaveLength(0);

    const [row] = await testDb
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.id, task.id))
      .limit(1);
    expect(row?.completedAt?.toISOString()).toBe(originalAt.toISOString());
  });

  it("PATCH on a non-completion field (priority) does not fire task_completed", async () => {
    const task = await seedTask(testDb, { orgId: orgA.id });

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(withAuth(adminA.id))
      .send({ priority: "high" });
    expect(res.status).toBe(200);

    const enq = getEnqueuedJobs().filter(
      (j) => (j.data as { trigger?: string }).trigger === "task_completed",
    );
    expect(enq).toHaveLength(0);
  });

  it("returns 404 for non-existent task", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${randomUUID()}`)
      .set(withAuth(adminA.id))
      .send({ status: "completed" });
    expect(res.status).toBe(404);
  });

  it("SQL-level replay: pre-fix pattern fires twice; conditional update fires once", async () => {
    // BUGGY: both callers see status="open" and both fire.
    const buggyTask = await seedTask(testDb, { orgId: orgA.id });
    const [rowA] = await testDb.select().from(taskInstancesTable).where(eq(taskInstancesTable.id, buggyTask.id)).limit(1);
    const [rowB] = await testDb.select().from(taskInstancesTable).where(eq(taskInstancesTable.id, buggyTask.id)).limit(1);
    const buggyFires: string[] = [];
    await testDb.update(taskInstancesTable).set({ status: "completed", completedAt: new Date() }).where(eq(taskInstancesTable.id, buggyTask.id));
    if (rowA) buggyFires.push("fired-a");
    await testDb.update(taskInstancesTable).set({ status: "completed", completedAt: new Date() }).where(eq(taskInstancesTable.id, buggyTask.id));
    if (rowB) buggyFires.push("fired-b");
    expect(buggyFires).toHaveLength(2);

    // FIXED: conditional UPDATE; only one returning() row.
    const fixedTask = await seedTask(testDb, { orgId: orgA.id });
    const fixedFires: string[] = [];
    const [updA] = await testDb
      .update(taskInstancesTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(eq(taskInstancesTable.id, fixedTask.id), ne(taskInstancesTable.status, "completed")))
      .returning();
    if (updA) fixedFires.push("fired-a");
    const [updB] = await testDb
      .update(taskInstancesTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(eq(taskInstancesTable.id, fixedTask.id), ne(taskInstancesTable.status, "completed")))
      .returning();
    if (updB) fixedFires.push("fired-b");
    expect(fixedFires).toHaveLength(1);
  });
});

// ============================================================================
// PATCH /sequences/:id/enrollments/:eid — cancel TOCTOU
// ============================================================================

async function seedSequence(db: TestDb, opts: { orgId: string }): Promise<{ id: string }> {
  const id = `seq-${randomUUID()}`;
  await db.insert(sequencesTable).values({ id, orgId: opts.orgId, name: "Test seq" });
  return { id };
}

async function seedEnrollment(
  db: TestDb,
  opts: { sequenceId: string; contactId: string; status?: "active" | "paused" | "cancelled" | "completed" },
): Promise<{ id: string }> {
  const id = `enr-${randomUUID()}`;
  await db.insert(sequenceEnrollmentsTable).values({
    id,
    sequenceId: opts.sequenceId,
    contactId: opts.contactId,
    status: opts.status ?? "active",
  });
  return { id };
}

describe("PATCH /sequences/:id/enrollments/:eid — cancel TOCTOU", () => {
  it("re-cancel preserves the original completedAt timestamp", async () => {
    const seq = await seedSequence(testDb, { orgId: orgA.id });
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const enr = await seedEnrollment(testDb, { sequenceId: seq.id, contactId: contact.id });

    const first = await request(app)
      .patch(`/api/sequences/${seq.id}/enrollments/${enr.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "cancelled" });
    expect(first.status).toBe(200);

    const [afterFirst] = await testDb
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enr.id))
      .limit(1);
    const originalCompletedAt = afterFirst?.completedAt;
    expect(originalCompletedAt).not.toBeNull();

    // Wait a moment so a buggy implementation that overwrites would
    // visibly produce a different timestamp.
    await new Promise((r) => setTimeout(r, 5));

    const second = await request(app)
      .patch(`/api/sequences/${seq.id}/enrollments/${enr.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "cancelled" });
    expect(second.status).toBe(200);

    const [afterSecond] = await testDb
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enr.id))
      .limit(1);
    expect(afterSecond?.completedAt?.toISOString()).toBe(originalCompletedAt?.toISOString());
  });

  it("first cancel sets completedAt; non-cancel transitions don't touch it", async () => {
    const seq = await seedSequence(testDb, { orgId: orgA.id });
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });
    const enr = await seedEnrollment(testDb, { sequenceId: seq.id, contactId: contact.id });

    const pauseRes = await request(app)
      .patch(`/api/sequences/${seq.id}/enrollments/${enr.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "paused" });
    expect(pauseRes.status).toBe(200);

    const [pausedRow] = await testDb
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enr.id))
      .limit(1);
    expect(pausedRow?.status).toBe("paused");
    expect(pausedRow?.completedAt).toBeNull();

    const cancelRes = await request(app)
      .patch(`/api/sequences/${seq.id}/enrollments/${enr.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "cancelled" });
    expect(cancelRes.status).toBe(200);

    const [cancelledRow] = await testDb
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enr.id))
      .limit(1);
    expect(cancelledRow?.status).toBe("cancelled");
    expect(cancelledRow?.completedAt).not.toBeNull();
  });

  it("returns 404 for non-existent enrollment", async () => {
    const seq = await seedSequence(testDb, { orgId: orgA.id });
    const res = await request(app)
      .patch(`/api/sequences/${seq.id}/enrollments/${randomUUID()}`)
      .set(withAuth(adminA.id))
      .send({ status: "cancelled" });
    expect(res.status).toBe(404);
  });

  it("SQL-level replay: pre-fix overwrites completedAt; conditional update preserves it", async () => {
    const seq = await seedSequence(testDb, { orgId: orgA.id });
    const contact = await seedContact(testDb, { orgId: orgA.id, status: "lead" });

    // BUGGY: unconditional UPDATE overwrites completedAt on every call.
    const buggyEnr = await seedEnrollment(testDb, { sequenceId: seq.id, contactId: contact.id });
    const firstAt = new Date("2024-01-01T00:00:00.000Z");
    await testDb
      .update(sequenceEnrollmentsTable)
      .set({ status: "cancelled", completedAt: firstAt })
      .where(eq(sequenceEnrollmentsTable.id, buggyEnr.id));
    const secondAt = new Date("2024-06-01T00:00:00.000Z");
    await testDb
      .update(sequenceEnrollmentsTable)
      .set({ status: "cancelled", completedAt: secondAt })
      .where(eq(sequenceEnrollmentsTable.id, buggyEnr.id));
    const [buggyRow] = await testDb
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, buggyEnr.id))
      .limit(1);
    // The bug: the second (idempotent) cancel overwrote the original
    // cancellation timestamp.
    expect(buggyRow?.completedAt?.toISOString()).toBe(secondAt.toISOString());

    // FIXED: conditional UPDATE excludes already-terminal statuses.
    const fixedEnr = await seedEnrollment(testDb, { sequenceId: seq.id, contactId: contact.id });
    const fixedAt = new Date("2024-01-01T00:00:00.000Z");
    await testDb
      .update(sequenceEnrollmentsTable)
      .set({ status: "cancelled", completedAt: fixedAt })
      .where(
        and(
          eq(sequenceEnrollmentsTable.id, fixedEnr.id),
          notInArray(sequenceEnrollmentsTable.status, ["cancelled", "completed"]),
        ),
      );
    const retryAt = new Date("2024-06-01T00:00:00.000Z");
    await testDb
      .update(sequenceEnrollmentsTable)
      .set({ status: "cancelled", completedAt: retryAt })
      .where(
        and(
          eq(sequenceEnrollmentsTable.id, fixedEnr.id),
          notInArray(sequenceEnrollmentsTable.status, ["cancelled", "completed"]),
        ),
      );
    const [fixedRow] = await testDb
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, fixedEnr.id))
      .limit(1);
    // The fix: the original cancellation timestamp is preserved.
    expect(fixedRow?.completedAt?.toISOString()).toBe(fixedAt.toISOString());
  });
});
