/**
 * Automated sends must respect a contact's channel opt-out flags.
 *
 * Before this fix the sequence email step ignored `optOutEmail` (CAN-SPAM
 * exposure).
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
  contactsTable,
  sequencesTable,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedContact } from "../helpers/testDb";
import type { TestDbHandle } from "../helpers/testDb";

let handle: TestDbHandle;
let org: { id: string };
let sendSequenceStepWorker: typeof import("../../workers/sendSequenceStep").sendSequenceStepWorker;

async function contactWith(flags: { optOutEmail?: boolean; optOutSms?: boolean }) {
  const c = await seedContact(handle.db, { orgId: org.id, firstName: `Opt-${randomUUID().slice(0, 6)}` });
  await handle.db
    .update(contactsTable)
    .set({
      email: `${c.id}@example.com`,
      phone: "+15555550123",
      optOutEmail: flags.optOutEmail ?? false,
      optOutSms: flags.optOutSms ?? false,
    })
    .where(eq(contactsTable.id, c.id));
  return c;
}

async function runEmailSequenceStep(contactId: string) {
  const sequenceId = `seq-${randomUUID()}`;
  await handle.db.insert(sequencesTable).values({
    id: sequenceId, orgId: org.id, name: "Opt-out seq", status: "active", triggerType: "manual",
  });
  await handle.db.insert(sequenceStepsTable).values([
    { id: `step-${randomUUID()}`, sequenceId, stepType: "email", orderIndex: 0, delayValue: 0, delayUnit: "days",
      config: { subject: "Hi", html: "<p>Hi</p>" } },
    { id: `step-${randomUUID()}`, sequenceId, stepType: "wait", orderIndex: 1, delayValue: 0, delayUnit: "days", config: null },
  ]);
  await handle.db.insert(sequenceEnrollmentsTable).values({
    id: `enr-${randomUUID()}`, sequenceId, contactId, status: "active", nextStepIndex: 0,
  });
  await sendSequenceStepWorker({ sequenceId, contactId, stepIndex: 0, channel: "email" });
}

const jobs = (name: string) => getEnqueuedJobs().filter((j) => j.name === name);

beforeAll(async () => {
  handle = await bootTestDb();
  ({ sendSequenceStepWorker } = await import("../../workers/sendSequenceStep"));
  org = await seedOrg(handle.db, { id: "opt-out-org" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("sequence email step", () => {
  it("sends to a contact who has not opted out", async () => {
    const c = await contactWith({});
    await runEmailSequenceStep(c.id);
    expect(jobs("send-scheduled-email")).toHaveLength(1);
  });

  it("skips a contact who opted out of email", async () => {
    const c = await contactWith({ optOutEmail: true });
    await runEmailSequenceStep(c.id);
    expect(jobs("send-scheduled-email")).toHaveLength(0);
  });
});

// Automation-rule sends are gated at send time by the consumer outreach gate;
// see automation-consumer-outreach.test.ts and consumer-outreach-gate.test.ts.
