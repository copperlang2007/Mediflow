/**
 * Integration tests for the bulk sequence-enroll endpoint
 * (POST /api/sequences/:id/enroll).
 *
 * The route was refactored from a per-contact loop (~5N round-trips) into
 * a set-based implementation. These tests verify:
 *   1. Functional correctness (split between enrolled / skipped).
 *   2. Idempotency for already-active enrollments.
 *   3. Step-type gating of the first-step enqueue (sms/email vs task/wait).
 *   4. Job-fanout cardinality matches `enrolled`, not the input length.
 *   5. A loose wall-clock budget that would be impossible under the old
 *      per-contact RTT pattern (200+ sequential queries against pglite).
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

import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  sequencesTable,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
  activitiesTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";

import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// supertest's CJS default import is awkward to type with --moduleResolution
// bundler; the existing integration tests use `as any` here so we follow suit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;

let org: { id: string };
let admin: { id: string };
let handle: TestDbHandle;

async function seedSequence(opts: {
  orgId: string;
  name?: string;
  steps?: Array<{
    stepType: "sms" | "email" | "task" | "wait";
    orderIndex?: number;
  }>;
}): Promise<{ id: string }> {
  const id = `seq-${randomUUID()}`;
  await handle.db.insert(sequencesTable).values({
    id,
    orgId: opts.orgId,
    name: opts.name ?? "Bulk enroll seq",
    status: "active",
    triggerType: "manual",
  });
  for (const [idx, step] of (opts.steps ?? []).entries()) {
    await handle.db.insert(sequenceStepsTable).values({
      id: `step-${randomUUID()}`,
      sequenceId: id,
      stepType: step.stepType,
      orderIndex: step.orderIndex ?? idx,
      delayValue: 0,
      delayUnit: "days",
    });
  }
  return { id };
}

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "seq-bulk-org" });
  admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("POST /api/sequences/:id/enroll — bulk enrollment", () => {
  it("splits valid + non-existent contact ids: 100 enrolled, 10 skipped, and finishes within budget", async () => {
    const seq = await seedSequence({
      orgId: org.id,
      steps: [{ stepType: "email" }],
    });

    const contactIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const c = await seedContact(handle.db, {
        orgId: org.id,
        firstName: `Bulk${i}`,
      });
      contactIds.push(c.id);
    }
    const bogusIds = Array.from({ length: 10 }, (_, i) => `does-not-exist-${i}`);
    const payload = [...contactIds, ...bogusIds];

    const t0 = Date.now();
    const res = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: payload });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: 100, skipped: 10 });

    // Coarse wall-clock backstop only. The real assertions are the status
    // and `{ enrolled, skipped }` body above; this just catches a gross
    // regression back to the old per-contact pattern (~550 sequential
    // pglite queries) vs. the set-based version (~5 fixed queries + N
    // parallel enqueues). The bound is deliberately huge — a loaded CI
    // runner can stall an HTTP round-trip for seconds — so it cannot flake
    // while still failing if someone reintroduces O(N) sequential queries.
    expect(elapsed).toBeLessThan(15000);

    const enrolls = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.sequenceId, seq.id));
    expect(enrolls).toHaveLength(100);
    expect(new Set(enrolls.map((e) => e.contactId))).toEqual(new Set(contactIds));

    const acts = await handle.db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.orgId, org.id),
          eq(activitiesTable.type, "sequence_enrolled"),
        ),
      );
    expect(acts.length).toBeGreaterThanOrEqual(100);
  });

  it("skips contacts already actively enrolled (all 100 → 0 enrolled, 100 skipped)", async () => {
    const seq = await seedSequence({
      orgId: org.id,
      steps: [{ stepType: "sms" }],
    });

    const contactIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const c = await seedContact(handle.db, { orgId: org.id });
      contactIds.push(c.id);
    }

    // First call: enroll everyone.
    const first = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ enrolled: 100, skipped: 0 });

    clearEnqueuedJobs();

    // Second call: same contacts, all already active → all skipped.
    const second = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ enrolled: 0, skipped: 100 });

    // No new enqueues for the re-enroll attempt.
    expect(getEnqueuedJobs()).toHaveLength(0);
  });

  it("handles mixed input: existing + already-active + non-existent", async () => {
    const seq = await seedSequence({
      orgId: org.id,
      steps: [{ stepType: "email" }],
    });

    const newContacts = await Promise.all(
      Array.from({ length: 5 }, () => seedContact(handle.db, { orgId: org.id })),
    );
    const preEnrolled = await Promise.all(
      Array.from({ length: 3 }, () => seedContact(handle.db, { orgId: org.id })),
    );

    // Pre-enroll the second group.
    const pre = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: preEnrolled.map((c) => c.id) });
    expect(pre.body).toEqual({ enrolled: 3, skipped: 0 });

    clearEnqueuedJobs();

    const bogus = ["nope-1", "nope-2"];
    const payload = [
      ...newContacts.map((c) => c.id),
      ...preEnrolled.map((c) => c.id),
      ...bogus,
    ];

    const res = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: payload });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: 5, skipped: 5 });
    // Only the 5 new contacts should be enqueued.
    expect(getEnqueuedJobs()).toHaveLength(5);
  });

  it("enqueues SEND_SEQUENCE_STEP exactly once per ENROLLED contact (not per input id)", async () => {
    const seq = await seedSequence({
      orgId: org.id,
      steps: [{ stepType: "sms" }],
    });

    const real = await Promise.all(
      Array.from({ length: 4 }, () => seedContact(handle.db, { orgId: org.id })),
    );
    const fake = ["ghost-a", "ghost-b", "ghost-c"];

    const res = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: [...real.map((c) => c.id), ...fake] });

    expect(res.body).toEqual({ enrolled: 4, skipped: 3 });

    const jobs = getEnqueuedJobs().filter(
      (j) => j.name === "send-sequence-step",
    );
    expect(jobs).toHaveLength(4);
    const enqueuedContactIds = new Set(
      jobs.map((j) => (j.data as { contactId: string }).contactId),
    );
    expect(enqueuedContactIds).toEqual(new Set(real.map((c) => c.id)));
  });

  it("creates enrollments but skips enqueue when the sequence has no steps", async () => {
    const seq = await seedSequence({ orgId: org.id, steps: [] });
    const contact = await seedContact(handle.db, { orgId: org.id });

    const res = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: [contact.id] });

    expect(res.body).toEqual({ enrolled: 1, skipped: 0 });

    const enrolls = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.sequenceId, seq.id));
    expect(enrolls).toHaveLength(1);

    const jobs = getEnqueuedJobs().filter(
      (j) => j.name === "send-sequence-step",
    );
    expect(jobs).toHaveLength(0);
  });

  it("creates enrollments but skips immediate enqueue when first step is `wait`", async () => {
    const seq = await seedSequence({
      orgId: org.id,
      steps: [{ stepType: "wait" }, { stepType: "email" }],
    });
    const contact = await seedContact(handle.db, { orgId: org.id });

    const res = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: [contact.id] });

    expect(res.body).toEqual({ enrolled: 1, skipped: 0 });

    const enrolls = await handle.db
      .select()
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.sequenceId, seq.id));
    expect(enrolls).toHaveLength(1);

    expect(
      getEnqueuedJobs().filter((j) => j.name === "send-sequence-step"),
    ).toHaveLength(0);
  });

  it("creates enrollments but skips immediate enqueue when first step is `task`", async () => {
    const seq = await seedSequence({
      orgId: org.id,
      steps: [{ stepType: "task" }],
    });
    const contact = await seedContact(handle.db, { orgId: org.id });

    const res = await request(app)
      .post(`/api/sequences/${seq.id}/enroll`)
      .set(withAuth(admin.id))
      .send({ contactIds: [contact.id] });

    expect(res.body).toEqual({ enrolled: 1, skipped: 0 });

    expect(
      getEnqueuedJobs().filter((j) => j.name === "send-sequence-step"),
    ).toHaveLength(0);
  });
});
