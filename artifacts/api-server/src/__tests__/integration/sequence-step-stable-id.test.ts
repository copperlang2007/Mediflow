/**
 * Correctness under operator mid-flight edits of sequence steps.
 *
 * Before this fix, `sendSequenceStepWorker` resolved the "next step to
 * execute" by positional offset (`stepIndex`) into the
 * order_index-sorted step list. Any deletion, insertion, or reordering
 * of steps in a sequence with in-flight enrollments silently shifted
 * every enrollment's pointer to a DIFFERENT logical step — wrong-
 * content emails / SMS / tasks fired with no audit trail of the bug.
 *
 * The fix:
 *   - `sequence_enrollments` gains `next_step_id` (stable FK to
 *     `sequence_steps.id`, ON DELETE SET NULL).
 *   - The `SEND_SEQUENCE_STEP` job payload gains `stepId`.
 *   - The worker resolves the target step BY ID, not by position.
 *   - When the targeted step has been deleted (FK SET NULL nulled the
 *     pointer, or payload references a missing id), the worker marks
 *     the enrollment as `completed` with a log line, rather than
 *     silently executing a wrong step.
 *
 * These tests cover the four mid-flight edit scenarios and verify
 * that legacy payloads (no `stepId`) still work via the back-compat
 * positional fallback.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  sequencesTable,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
  taskInstancesTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedContact } from "../helpers/testDb";
import type { TestDbHandle } from "../helpers/testDb";

let sendSequenceStepWorker: typeof import("../../workers/sendSequenceStep").sendSequenceStepWorker;
let handle: TestDbHandle;
let org: { id: string };

interface SeededStep {
  id: string;
  stepType: "sms" | "email" | "task" | "wait";
  orderIndex: number;
  config: Record<string, unknown> | null;
}

async function seedSequenceWithSteps(opts: {
  orgId: string;
  steps: Array<{
    stepType: "sms" | "email" | "task" | "wait";
    config?: Record<string, unknown>;
  }>;
}): Promise<{ sequenceId: string; steps: SeededStep[] }> {
  const sequenceId = `seq-${randomUUID()}`;
  await handle.db.insert(sequencesTable).values({
    id: sequenceId,
    orgId: opts.orgId,
    name: "Stable-id seq",
    status: "active",
    triggerType: "manual",
  });
  const seededSteps: SeededStep[] = [];
  for (const [idx, step] of opts.steps.entries()) {
    const id = `step-${randomUUID()}`;
    await handle.db.insert(sequenceStepsTable).values({
      id,
      sequenceId,
      stepType: step.stepType,
      orderIndex: idx,
      delayValue: 0,
      delayUnit: "days",
      config: step.config ?? null,
    });
    seededSteps.push({
      id,
      stepType: step.stepType,
      orderIndex: idx,
      config: step.config ?? null,
    });
  }
  return { sequenceId, steps: seededSteps };
}

async function seedActiveEnrollment(opts: {
  sequenceId: string;
  contactId: string;
  nextStepId: string | null;
  nextStepIndex?: number;
}): Promise<{ id: string }> {
  const id = `enr-${randomUUID()}`;
  await handle.db.insert(sequenceEnrollmentsTable).values({
    id,
    sequenceId: opts.sequenceId,
    contactId: opts.contactId,
    status: "active",
    nextStepIndex: opts.nextStepIndex ?? 0,
    nextStepId: opts.nextStepId,
  });
  return { id };
}

beforeAll(async () => {
  handle = await bootTestDb();
  ({ sendSequenceStepWorker } = await import("../../workers/sendSequenceStep"));
  org = await seedOrg(handle.db, { id: "seq-stable-id-org" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("sendSequenceStepWorker — stable step identity across mid-flight edits", () => {
  it("baseline: 5-step sequence executes step 0 and advances pointer to step 1's id", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Baseline",
    });
    const { sequenceId, steps } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "S0 task" } },
        { stepType: "task", config: { title: "S1 task" } },
        { stepType: "task", config: { title: "S2 task" } },
        { stepType: "task", config: { title: "S3 task" } },
        { stepType: "task", config: { title: "S4 task" } },
      ],
    });
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
      nextStepId: steps[0].id,
    });

    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepId: steps[0].id,
      stepIndex: 0,
      channel: "email",
    });

    // Step 0's task was created.
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const s0Tasks = tasks.filter((t) => t.title === "S0 task");
    expect(s0Tasks).toHaveLength(1);

    // Pointer now references step 1 by ID.
    const [enr] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(enr?.nextStepId).toBe(steps[1].id);
    expect(enr?.status).toBe("active");
  });

  it("step deletion mid-flight: enrollment is completed gracefully, NOT advanced to the now-shifted step", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Deleted",
    });
    const { sequenceId, steps } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "Del-S0" } },
        { stepType: "task", config: { title: "Del-S1" } }, // <-- will be deleted
        { stepType: "task", config: { title: "Del-S2" } },
      ],
    });
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
      nextStepId: steps[0].id,
    });

    // Execute step 0 — pointer advances to step 1.
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepId: steps[0].id,
      stepIndex: 0,
      channel: "email",
    });

    const [enrAfterFirst] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(enrAfterFirst?.nextStepId).toBe(steps[1].id);

    // Operator deletes step 1. FK SET NULL nulls out the pointer.
    await handle.db
      .delete(sequenceStepsTable)
      .where(eq(sequenceStepsTable.id, steps[1].id));

    const [enrAfterDelete] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(enrAfterDelete?.nextStepId).toBeNull();

    // Worker fires (scheduled enqueue from the prior advance). Use the
    // enqueued payload (which now carries stepId for the deleted step).
    const enqueued = getEnqueuedJobs().filter(
      (j) => j.name === "send-sequence-step",
    );
    const scheduledForS1 = enqueued.find(
      (j) =>
        (j.data as { stepId?: string }).stepId === steps[1].id &&
        (j.data as { contactId?: string }).contactId === contact.id,
    );
    expect(scheduledForS1).toBeDefined();
    clearEnqueuedJobs();

    await sendSequenceStepWorker(
      scheduledForS1!.data as Parameters<typeof sendSequenceStepWorker>[0],
    );

    // The CRITICAL assertion: the worker did NOT silently execute the
    // step that now sits at position 1 (was originally step 2,
    // "Del-S2"). No new task was created beyond S0.
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const s2Tasks = tasks.filter((t) => t.title === "Del-S2");
    expect(s2Tasks).toHaveLength(0);

    // Enrollment is completed (not stuck active).
    const [finalEnr] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(finalEnr?.status).toBe("completed");
  });

  it("reorder mid-flight: enrollment still executes the ORIGINAL step it was pointed at", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Reorder",
    });
    const { sequenceId, steps } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "R-S0" } },
        { stepType: "task", config: { title: "R-S1-ORIGINAL" } }, // pointer
        { stepType: "task", config: { title: "R-S2" } },
        { stepType: "task", config: { title: "R-S3" } },
      ],
    });
    // Pointer is at step 1 (R-S1-ORIGINAL).
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
      nextStepId: steps[1].id,
      nextStepIndex: 1,
    });

    // Operator moves step 3 to position 1, original step 1 to position 3.
    // (We rewrite orderIndex; IDs are stable.)
    await handle.db
      .update(sequenceStepsTable)
      .set({ orderIndex: 3 })
      .where(eq(sequenceStepsTable.id, steps[1].id));
    await handle.db
      .update(sequenceStepsTable)
      .set({ orderIndex: 1 })
      .where(eq(sequenceStepsTable.id, steps[3].id));

    // Fire the worker. With the OLD bug, this would have executed
    // whatever step now sits at positional index 1 — i.e. R-S3.
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepId: steps[1].id,
      stepIndex: 1,
      channel: "email",
    });

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const originalRun = tasks.filter((t) => t.title === "R-S1-ORIGINAL");
    const wrongRun = tasks.filter((t) => t.title === "R-S3");
    expect(originalRun).toHaveLength(1);
    expect(wrongRun).toHaveLength(0);
  });

  it("insert mid-flight: enrollment executes its originally-pointed-to step, not the new step at position 0", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Insert",
    });
    const { sequenceId, steps } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "I-S0-ORIGINAL" } }, // pointer
        { stepType: "task", config: { title: "I-S1" } },
      ],
    });
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
      nextStepId: steps[0].id,
      nextStepIndex: 0,
    });

    // Operator inserts a new step at position 0 (the one currently
    // there becomes position 1). With the old bug, the in-flight
    // enrollment with nextStepIndex=0 would now execute "I-S-NEW".
    await handle.db
      .update(sequenceStepsTable)
      .set({ orderIndex: 1 })
      .where(eq(sequenceStepsTable.id, steps[0].id));
    await handle.db
      .update(sequenceStepsTable)
      .set({ orderIndex: 2 })
      .where(eq(sequenceStepsTable.id, steps[1].id));
    const insertedId = `step-${randomUUID()}`;
    await handle.db.insert(sequenceStepsTable).values({
      id: insertedId,
      sequenceId,
      stepType: "task",
      orderIndex: 0,
      delayValue: 0,
      delayUnit: "days",
      config: { title: "I-S-NEW" },
    });

    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepId: steps[0].id,
      stepIndex: 0,
      channel: "email",
    });

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const originalRun = tasks.filter((t) => t.title === "I-S0-ORIGINAL");
    const newRun = tasks.filter((t) => t.title === "I-S-NEW");
    expect(originalRun).toHaveLength(1);
    expect(newRun).toHaveLength(0);

    // Pointer should advance to the original step's next-by-order_index,
    // which is now the inserted step's successor — i.e. the originally
    // step 0 has orderIndex=1, next is the original step 1 (orderIndex=2).
    const [enr] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(enr?.nextStepId).toBe(steps[1].id);
  });

  it("legacy payload (stepIndex only, no stepId) still works via back-compat fallback and backfills nextStepId", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Legacy",
    });
    const { sequenceId, steps } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "Legacy-S0" } },
        { stepType: "task", config: { title: "Legacy-S1" } },
      ],
    });
    // Seed an enrollment WITHOUT nextStepId — mimics a pre-migration
    // row that's been backfilled-by-update lazily.
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
      nextStepId: null,
    });

    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      // Note: no stepId on this payload — simulates an in-flight
      // pg-boss job enqueued by the pre-migration worker.
      stepIndex: 0,
      channel: "email",
    });

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const ran = tasks.filter((t) => t.title === "Legacy-S0");
    expect(ran).toHaveLength(1);

    // The worker should have backfilled nextStepId and then advanced
    // to step 1.
    const [enr] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(enr?.nextStepId).toBe(steps[1].id);
    // The next enqueue should carry stepId (new format).
    const nextEnqueues = getEnqueuedJobs().filter(
      (j) => j.name === "send-sequence-step",
    );
    expect(nextEnqueues).toHaveLength(1);
    expect((nextEnqueues[0]?.data as { stepId?: string }).stepId).toBe(
      steps[1].id,
    );
  });
});
