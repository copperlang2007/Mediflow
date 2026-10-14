/**
 * Integration test: AEP annual-review task generation.
 *
 * Each fall (before Oct 1) the generator creates one "set the annual review
 * appointment" to-do per current Medicare Advantage member, assigned to the
 * member's agent's user, due before Oct 1 of the season year.
 *
 * Member signal (see lib/aepRenewal/generate.ts):
 *   contacts.status IN ('enrolled','retained')
 *     AND contacts.current_plan_type IN ('MA','MAPD')
 *     AND contacts.assigned_agent_id IS NOT NULL
 *     AND agents.user_id IS NOT NULL  (task is assigned to a USER)
 *     AND contacts.deleted_at IS NULL
 *
 * Idempotency: each task carries a deterministic
 * `auto_assign_trigger = aep_renewal:<year>:<contactId>`; a re-run skips any
 * member that already has this season's task.
 *
 * Coverage:
 *   1. A task is created for each eligible member, assigned to the member's
 *      agent's user, due before Oct 1 of the season year.
 *   2. A non-member (status='lead') / unassigned contact is skipped.
 *   3. A member who ALREADY has this year's task gets no duplicate.
 *   4. A second run creates nothing new (idempotent).
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
  agentsTable,
  contactsTable,
  taskInstancesTable,
  type Contact,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent, seedContact, type TestDb } from "../helpers/testDb";

let generateAepRenewalTasks: typeof import("../../lib/aepRenewal/generate").generateAepRenewalTasks;
let aepRenewalTrigger: typeof import("../../lib/aepRenewal/generate").aepRenewalTrigger;
let AEP_TASK_TITLE: typeof import("../../lib/aepRenewal/generate").AEP_TASK_TITLE;
let db: TestDb;
let orgId: string;

// Fixed clock inside the 2026 season — generation keys off the calendar year.
const NOW = new Date("2026-08-15T00:00:00.000Z");
const YEAR = 2026;
const OCT_1 = new Date(Date.UTC(YEAR, 9, 1, 0, 0, 0));

/** Seed an agent that has a linked user (assignable target for tasks). */
async function seedAgentWithUser(opts: {
  firstName: string;
  userId: string;
}): Promise<{ agentId: string; userId: string }> {
  const { id: agentId } = await seedAgent(db, {
    orgId,
    firstName: opts.firstName,
    lastName: "Agent",
  });
  await db
    .update(agentsTable)
    .set({ userId: opts.userId })
    .where(eq(agentsTable.id, agentId));
  return { agentId, userId: opts.userId };
}

/** Seed a contact, then set the agent / plan-type / status fields the generator filters on. */
async function seedMember(opts: {
  firstName: string;
  status: Contact["status"];
  planType: "MA" | "MAPD" | "PDP" | null;
  assignedAgentId: string | null;
}): Promise<{ id: string }> {
  const c = await seedContact(db, {
    orgId,
    firstName: opts.firstName,
    lastName: "Member",
    status: opts.status,
  });
  await db
    .update(contactsTable)
    .set({
      assignedAgentId: opts.assignedAgentId,
      currentPlanType: opts.planType,
    })
    .where(eq(contactsTable.id, c.id));
  return { id: c.id };
}

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  const mod = await import("../../lib/aepRenewal/generate");
  generateAepRenewalTasks = mod.generateAepRenewalTasks;
  aepRenewalTrigger = mod.aepRenewalTrigger;
  AEP_TASK_TITLE = mod.AEP_TASK_TITLE;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  // Fresh org per test keeps the per-org generation + dedup assertions clean.
  const o = await seedOrg(db, { id: `org-aep-${randomUUID().slice(0, 8)}` });
  orgId = o.id;
});

describe("AEP annual-review task generation", () => {
  it("creates one task per eligible member, assigned to the agent's user, due before Oct 1; skips non-members/unassigned and pre-existing", async () => {
    const agentA = await seedAgentWithUser({ firstName: "Ana", userId: `user-${randomUUID()}` });
    const agentB = await seedAgentWithUser({ firstName: "Ben", userId: `user-${randomUUID()}` });

    // Two eligible members (MA + MAPD) assigned to agents with users.
    const m1 = await seedMember({ firstName: "M1", status: "enrolled", planType: "MA", assignedAgentId: agentA.agentId });
    const m2 = await seedMember({ firstName: "M2", status: "retained", planType: "MAPD", assignedAgentId: agentB.agentId });

    // Non-member: a lead (not a current client) — must be skipped.
    await seedMember({ firstName: "Lead", status: "lead", planType: "MA", assignedAgentId: agentA.agentId });
    // Member without an assigned agent — must be skipped.
    await seedMember({ firstName: "Unassigned", status: "enrolled", planType: "MA", assignedAgentId: null });

    // A member who ALREADY has this year's renewal task — no duplicate.
    const already = await seedMember({ firstName: "Already", status: "enrolled", planType: "MA", assignedAgentId: agentA.agentId });
    await db.insert(taskInstancesTable).values({
      id: randomUUID(),
      orgId,
      contactId: already.id,
      agentId: agentA.agentId,
      assignedToUserId: agentA.userId,
      title: AEP_TASK_TITLE,
      status: "open",
      priority: "high",
      autoAssignTrigger: aepRenewalTrigger(YEAR, already.id),
    });

    const summary = await generateAepRenewalTasks({ db, now: NOW, orgId });

    expect(summary.year).toBe(YEAR);
    // Two new tasks (m1, m2). "already" is skipped; lead + unassigned never match.
    expect(summary.created).toBe(2);
    expect(summary.skipped).toBe(1);

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, orgId));

    // 3 total: 2 newly created + 1 pre-existing.
    expect(tasks).toHaveLength(3);

    const m1Task = tasks.find((t) => t.contactId === m1.id);
    const m2Task = tasks.find((t) => t.contactId === m2.id);
    expect(m1Task).toBeDefined();
    expect(m2Task).toBeDefined();

    // Assigned to the member's agent's user.
    expect(m1Task!.assignedToUserId).toBe(agentA.userId);
    expect(m2Task!.assignedToUserId).toBe(agentB.userId);

    // Deterministic dedup trigger.
    expect(m1Task!.autoAssignTrigger).toBe(aepRenewalTrigger(YEAR, m1.id));

    // Due before Oct 1 of the season year.
    for (const t of [m1Task!, m2Task!]) {
      expect(t.dueDate).not.toBeNull();
      expect(t.dueDate!.getTime()).toBeLessThan(OCT_1.getTime());
      expect(t.status).toBe("open");
    }

    // No task was created for the lead or unassigned contact.
    const eligibleContactIds = new Set(tasks.map((t) => t.contactId));
    expect(eligibleContactIds.size).toBe(3); // m1, m2, already only
  });

  it("is idempotent — a second run creates nothing new", async () => {
    const agent = await seedAgentWithUser({ firstName: "Ida", userId: `user-${randomUUID()}` });
    await seedMember({ firstName: "Mem", status: "retained", planType: "MAPD", assignedAgentId: agent.agentId });

    const first = await generateAepRenewalTasks({ db, now: NOW, orgId });
    expect(first.created).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await generateAepRenewalTasks({ db, now: NOW, orgId });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    const tasks = await db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, orgId));
    expect(tasks).toHaveLength(1);
  });
});
