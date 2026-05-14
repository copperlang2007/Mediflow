/**
 * Idempotency guarantees for the sendSequenceStep worker.
 *
 * The original implementation fired its side effect (insert task row /
 * enqueue Twilio SMS / enqueue Resend email) BEFORE advancing the
 * enrollment pointer. A pg-boss retry triggered by a worker crash or
 * timeout between those two writes would re-run the whole worker and
 * re-fire the side effect — duplicate billed Twilio sends, duplicate
 * follow-up tasks on the agent's queue.
 *
 * The fix is an execution-log table (`sequence_step_executions`) with a
 * primary key on (enrollment_id, step_index). The worker claims its
 * slot via INSERT ... ON CONFLICT DO NOTHING before touching anything
 * external; on retry the conflict makes the worker skip the side
 * effect and just advance the pointer.
 *
 * These tests simulate retry by invoking the worker twice for the same
 * payload and asserting:
 *   1. "task" step → exactly one task row.
 *   2. "sms" step  → exactly one SEND_SCHEDULED_SMS enqueue.
 *   3. "wait" step → no duplicate ledger rows (PK enforces), pointer
 *      advances once.
 *   4. New enrollment at the same step_index → no collision (verifies
 *      the PK is correctly scoped to enrollment_id, not just stepIndex).
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
  sequencesTable,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
  sequenceStepExecutionsTable,
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

async function seedSequenceWithSteps(opts: {
  orgId: string;
  steps: Array<{
    stepType: "sms" | "email" | "task" | "wait";
    config?: Record<string, unknown>;
  }>;
}): Promise<{ sequenceId: string }> {
  const sequenceId = `seq-${randomUUID()}`;
  await handle.db.insert(sequencesTable).values({
    id: sequenceId,
    orgId: opts.orgId,
    name: "Idempotency seq",
    status: "active",
    triggerType: "manual",
  });
  for (const [idx, step] of opts.steps.entries()) {
    await handle.db.insert(sequenceStepsTable).values({
      id: `step-${randomUUID()}`,
      sequenceId,
      stepType: step.stepType,
      orderIndex: idx,
      delayValue: 0,
      delayUnit: "days",
      config: step.config ?? null,
    });
  }
  return { sequenceId };
}

async function seedActiveEnrollment(opts: {
  sequenceId: string;
  contactId: string;
}): Promise<{ id: string }> {
  const id = `enr-${randomUUID()}`;
  await handle.db.insert(sequenceEnrollmentsTable).values({
    id,
    sequenceId: opts.sequenceId,
    contactId: opts.contactId,
    status: "active",
    nextStepIndex: 0,
  });
  return { id };
}

beforeAll(async () => {
  handle = await bootTestDb();
  ({ sendSequenceStepWorker } = await import("../../workers/sendSequenceStep"));
  org = await seedOrg(handle.db, { id: "seq-idem-org" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("sendSequenceStepWorker — retry idempotency", () => {
  it("task step: re-running for the same (enrollment, stepIndex) inserts the task exactly once", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Tasker",
    });
    const { sequenceId } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "Call Tasker" } },
        { stepType: "wait" }, // tail so the worker doesn't mark completed
      ],
    });
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
    });

    // Attempt 1 — side effect runs, pointer advances.
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepIndex: 0,
      channel: "email",
    });

    // Simulate pg-boss retry of the same step. In production this would
    // happen because of a crash AFTER the task insert committed but
    // BEFORE the pointer-advance commit; here we just re-invoke. The
    // ledger claim made on attempt 1 is what suppresses the duplicate.
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepIndex: 0,
      channel: "email",
    });

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const forContact = tasks.filter((t) => t.title === "Call Tasker");
    expect(forContact).toHaveLength(1);

    const ledger = await handle.db
      .select()
      .from(sequenceStepExecutionsTable)
      .where(
        and(
          eq(sequenceStepExecutionsTable.enrollmentId, enrollment.id),
          eq(sequenceStepExecutionsTable.stepIndex, 0),
        ),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.sideEffect).toBe("task");
  });

  it("sms step: re-running enqueues SEND_SCHEDULED_SMS exactly once", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Sms",
    });
    // SMS requires a phone number on the contact. seedContact doesn't
    // accept phone; patch it directly so the channel branch fires.
    await handle.db
      .update((await import("@workspace/db/schema")).contactsTable)
      .set({ phone: "+15555550100" })
      .where(eq((await import("@workspace/db/schema")).contactsTable.id, contact.id));

    const { sequenceId } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "sms", config: { body: "Hello there" } },
        { stepType: "wait" },
      ],
    });
    await seedActiveEnrollment({ sequenceId, contactId: contact.id });

    // Attempt 1 + simulated retry attempt 2.
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepIndex: 0,
      channel: "sms",
    });
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepIndex: 0,
      channel: "sms",
    });

    const smsJobs = getEnqueuedJobs().filter(
      (j) => j.name === "send-scheduled-sms",
    );
    expect(smsJobs).toHaveLength(1);
  });

  it("wait step: PK enforces no duplicate ledger row; pointer advances once on first run", async () => {
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Waiter",
    });
    const { sequenceId } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [{ stepType: "wait" }, { stepType: "wait" }],
    });
    const enrollment = await seedActiveEnrollment({
      sequenceId,
      contactId: contact.id,
    });

    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepIndex: 0,
      channel: "email",
    });
    await sendSequenceStepWorker({
      sequenceId,
      contactId: contact.id,
      stepIndex: 0,
      channel: "email",
    });

    const ledger = await handle.db
      .select()
      .from(sequenceStepExecutionsTable)
      .where(
        and(
          eq(sequenceStepExecutionsTable.enrollmentId, enrollment.id),
          eq(sequenceStepExecutionsTable.stepIndex, 0),
        ),
      );
    expect(ledger).toHaveLength(1);

    // Pointer should have advanced past the wait step. Both attempts
    // advance to nextStepIndex=1; the second attempt just re-sets the
    // same value (no harm). Either way the resulting state is index 1.
    const [enr] = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollment.id));
    expect(enr?.nextStepIndex).toBe(1);
  });

  it("different enrollments can share the same stepIndex — PK is scoped per enrollment", async () => {
    const c1 = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Scoped1",
    });
    const c2 = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "Scoped2",
    });
    const { sequenceId } = await seedSequenceWithSteps({
      orgId: org.id,
      steps: [
        { stepType: "task", config: { title: "Scoped follow-up" } },
        { stepType: "wait" },
      ],
    });
    const e1 = await seedActiveEnrollment({ sequenceId, contactId: c1.id });
    const e2 = await seedActiveEnrollment({ sequenceId, contactId: c2.id });

    await sendSequenceStepWorker({
      sequenceId,
      contactId: c1.id,
      stepIndex: 0,
      channel: "email",
    });
    await sendSequenceStepWorker({
      sequenceId,
      contactId: c2.id,
      stepIndex: 0,
      channel: "email",
    });

    const ledger = await handle.db
      .select()
      .from(sequenceStepExecutionsTable)
      .where(eq(sequenceStepExecutionsTable.stepIndex, 0));
    const enrollmentIds = new Set(ledger.map((r) => r.enrollmentId));
    expect(enrollmentIds.has(e1.id)).toBe(true);
    expect(enrollmentIds.has(e2.id)).toBe(true);

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const scoped = tasks.filter((t) => t.title === "Scoped follow-up");
    // One per enrollment, no cross-contamination.
    expect(scoped).toHaveLength(2);
  });
});
