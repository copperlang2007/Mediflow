/**
 * Replay-guard for the daily automation sweep worker
 * (`weeklyAutomationSweep.ts`).
 *
 * The sweep scans every org for time-based triggers (license/cert
 * expiry, AHIP deadlines, contact-no-activity, task-overdue, scheduled)
 * and enqueues one `run-automation-rules` job per matching record.
 * pg-boss redelivers the whole sweep job on any non-success outcome
 * (worker crash, pg-boss connection drop, visibility-timeout expiry).
 *
 * The downstream `runAutomationRules` worker is NOT idempotent — it
 * unconditionally inserts notification rows, auto-creates tasks, writes
 * automation_rule_logs rows and re-enqueues emails/SMS. So a sweep
 * replay after a partial first run re-fires automation rules and
 * duplicate alerts for every record the first run already processed.
 *
 * Migration 0015 adds `automation_sweep_log`: the sweep claims a
 * (org_id, sweep_type, resource_id, sweep_run_date) row via
 * `INSERT ... ON CONFLICT DO NOTHING` and only enqueues when it claimed
 * the row. The cases below run the sweep twice (simulating a pg-boss
 * replay) and assert each record's automation is enqueued exactly once.
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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  contactsTable,
  taskInstancesTable,
  automationSweepLogTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  clearEnqueuedJobs,
  getEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedAgent, type TestDb } from "../helpers/testDb";

let dailyAutomationSweepWorker: typeof import("../../workers/weeklyAutomationSweep").dailyAutomationSweepWorker;

beforeAll(async () => {
  await bootTestDb();
  dailyAutomationSweepWorker = (
    await import("../../workers/weeklyAutomationSweep")
  ).dailyAutomationSweepWorker;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

// Each test gets its own org so per-org scans don't leak rows across
// test boundaries (org is the only filter in the scan queries).
async function freshOrg(db: TestDb): Promise<{ id: string }> {
  return seedOrg(db, { id: `sweep-replay-org-${randomUUID()}` });
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function seedLicense(
  db: TestDb,
  opts: { agentId: string; stateCode?: string },
): Promise<{ id: string }> {
  const id = `lic-${randomUUID()}`;
  await db.insert(stateLicensesTable).values({
    id,
    agentId: opts.agentId,
    stateCode: opts.stateCode ?? "TX",
    licenseType: "health",
    licenseNumber: `LN-${id.slice(-6)}`,
    status: "active",
    // Expires inside the 90-day scan horizon.
    expiryDate: daysFromNow(30),
  });
  return { id };
}

async function seedCarrier(
  db: TestDb,
  opts: { orgId: string },
): Promise<{ id: string }> {
  const id = `carrier-${randomUUID()}`;
  await db.insert(carriersTable).values({
    id,
    orgId: opts.orgId,
    name: "Test Carrier",
  });
  return { id };
}

async function seedCert(
  db: TestDb,
  opts: { agentId: string; carrierId: string },
): Promise<{ id: string }> {
  const id = `cert-${randomUUID()}`;
  await db.insert(carrierCertificationsTable).values({
    id,
    agentId: opts.agentId,
    carrierId: opts.carrierId,
    certificationYear: new Date().getFullYear(),
    expiryDate: daysFromNow(45),
  });
  return { id };
}

async function seedStaleContact(
  db: TestDb,
  opts: { orgId: string },
): Promise<{ id: string }> {
  const id = `contact-${randomUUID()}`;
  await db.insert(contactsTable).values({
    id,
    orgId: opts.orgId,
    firstName: "Stale",
    lastName: "Contact",
    status: "enrolled",
  });
  return { id };
}

async function seedOverdueTask(
  db: TestDb,
  opts: { orgId: string },
): Promise<{ id: string }> {
  const id = `task-${randomUUID()}`;
  await db.insert(taskInstancesTable).values({
    id,
    orgId: opts.orgId,
    title: "Overdue task",
    status: "open",
    priority: "medium",
    dueDate: daysFromNow(-5),
  });
  return { id };
}

function automationJobsFor(resourceId: string): Array<{ name: string; data: unknown }> {
  return getEnqueuedJobs().filter(
    (j) =>
      j.name === "run-automation-rules" &&
      (j.data as { resourceId?: string }).resourceId === resourceId,
  );
}

describe("weekly automation sweep — pg-boss replay guard", () => {
  it("running the sweep twice enqueues each record's automation exactly once", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const agent = await seedAgent(handle.db, { orgId: org.id });

    // One record of each scan type that exercises the per-record claim.
    const license = await seedLicense(handle.db, { agentId: agent.id });
    const carrier = await seedCarrier(handle.db, { orgId: org.id });
    const cert = await seedCert(handle.db, { agentId: agent.id, carrierId: carrier.id });
    const contact = await seedStaleContact(handle.db, { orgId: org.id });
    const task = await seedOverdueTask(handle.db, { orgId: org.id });

    // First sweep run — every record should be enqueued.
    await dailyAutomationSweepWorker();

    expect(automationJobsFor(license.id)).toHaveLength(1);
    expect(automationJobsFor(cert.id)).toHaveLength(1);
    expect(automationJobsFor(contact.id)).toHaveLength(1);
    expect(automationJobsFor(task.id)).toHaveLength(1);
    // The catch-all `scheduled` trigger keys on the org id.
    expect(automationJobsFor(org.id)).toHaveLength(1);

    // Simulate a pg-boss replay of the entire sweep job — pre-fix this
    // re-fired every record's automation a second time.
    await dailyAutomationSweepWorker();

    // Still exactly one job per record across BOTH runs combined.
    expect(automationJobsFor(license.id)).toHaveLength(1);
    expect(automationJobsFor(cert.id)).toHaveLength(1);
    expect(automationJobsFor(contact.id)).toHaveLength(1);
    expect(automationJobsFor(task.id)).toHaveLength(1);
    expect(automationJobsFor(org.id)).toHaveLength(1);

    // A third replay must still be a no-op.
    await dailyAutomationSweepWorker();
    expect(automationJobsFor(license.id)).toHaveLength(1);
    expect(automationJobsFor(cert.id)).toHaveLength(1);
  });

  it("writes one sweep-log claim row per record (audit trail)", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const agent = await seedAgent(handle.db, { orgId: org.id });
    const license = await seedLicense(handle.db, { agentId: agent.id });

    await dailyAutomationSweepWorker();
    await dailyAutomationSweepWorker(); // replay

    const claims = await handle.db
      .select()
      .from(automationSweepLogTable)
      .where(eq(automationSweepLogTable.resourceId, license.id));
    // Replay does not add a second claim row.
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sweepType).toBe("license_expiring");
    // sweep_run_date is the stable UTC calendar date.
    expect(claims[0]!.sweepRunDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("a new record added between sweep runs is still enqueued on the replay", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const agent = await seedAgent(handle.db, { orgId: org.id });
    const first = await seedLicense(handle.db, { agentId: agent.id });

    await dailyAutomationSweepWorker();
    expect(automationJobsFor(first.id)).toHaveLength(1);

    // A second license appears after the first run (e.g. the original
    // sweep crashed before scanning it). The replay must still pick it
    // up — the claim guard skips already-processed records, not new ones.
    const second = await seedLicense(handle.db, { agentId: agent.id });
    await dailyAutomationSweepWorker();

    expect(automationJobsFor(first.id)).toHaveLength(1);
    expect(automationJobsFor(second.id)).toHaveLength(1);
  });

  it("a claimed-but-unenqueued record is retried on the next sweep replay", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const agent = await seedAgent(handle.db, { orgId: org.id });
    const license = await seedLicense(handle.db, { agentId: agent.id });

    // Simulate the worker having claimed the row but the enqueue throwing
    // (pg-boss drop) — claimAndEnqueue rolls the claim back, so no row
    // should exist. Assert that, then prove the next sweep enqueues it.
    const claimsBefore = await handle.db
      .select()
      .from(automationSweepLogTable)
      .where(eq(automationSweepLogTable.resourceId, license.id));
    expect(claimsBefore).toHaveLength(0);

    await dailyAutomationSweepWorker();
    expect(automationJobsFor(license.id)).toHaveLength(1);
  });
});
