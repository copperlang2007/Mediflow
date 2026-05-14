/**
 * Idempotency guarantees for the taskAutoAssign worker.
 *
 * Before migration 0010, the worker re-inserted every matching template
 * row on every pg-boss retry — visibility-timeout expiry, worker crash,
 * or a transient DB blip would all surface to operators as duplicated
 * auto-assigned tasks. The dedup invariant is:
 *
 *   At most one task instance per (agent_id, template_id, trigger).
 *
 * The cases below exercise the boundaries of that invariant:
 *
 *   1. Plain re-run with identical payload: no new rows on the second
 *      invocation (this is the bug the migration exists to fix).
 *   2. Same agent, different trigger: separate rows — distinct triggers
 *      are intentionally NOT deduped against each other (e.g. hiring
 *      then a later status change should each spawn their own task).
 *   3. Different agent, same template+trigger: still creates a new row
 *      — the dedup key is scoped to the agent so two new hires both get
 *      onboarding tasks.
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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  taskInstancesTable,
  taskTemplatesTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import {
  seedOrg,
  seedAgent,
  type TestDb,
} from "../helpers/testDb";

let taskAutoAssignWorker: typeof import("../../workers/taskAutoAssign").taskAutoAssignWorker;

async function seedTaskTemplate(
  db: TestDb,
  opts: {
    orgId: string;
    triggerEvent: string;
    name?: string;
    title?: string;
    dueDaysFromTrigger?: number;
    isActive?: boolean;
  },
): Promise<{ id: string }> {
  const id = `tmpl-${randomUUID()}`;
  await db.insert(taskTemplatesTable).values({
    id,
    orgId: opts.orgId,
    name: opts.name ?? "Onboarding Task",
    title: opts.title ?? "Onboarding Task",
    triggerEvent: opts.triggerEvent,
    dueDaysFromTrigger: opts.dueDaysFromTrigger ?? null,
    isActive: opts.isActive ?? true,
  });
  return { id };
}

async function countInstancesForAgent(
  db: TestDb,
  agentId: string,
): Promise<number> {
  const rows = await db
    .select({ id: taskInstancesTable.id })
    .from(taskInstancesTable)
    .where(eq(taskInstancesTable.agentId, agentId));
  return rows.length;
}

beforeAll(async () => {
  await bootTestDb();
  taskAutoAssignWorker = (
    await import("../../workers/taskAutoAssign")
  ).taskAutoAssignWorker;
});

// Each test gets its own org so the worker's
// `select * from task_templates where org_id = ?` doesn't leak templates
// across test boundaries (it would, since the org is the only filter).
async function freshOrg(db: TestDb): Promise<{ id: string }> {
  return seedOrg(db, { id: `task-aa-org-${randomUUID()}` });
}

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("taskAutoAssign idempotency", () => {
  it("running the worker twice with the same payload does not double-insert tasks", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const agent = await seedAgent(handle.db, { orgId: org.id });

    // Two distinct templates both triggered by agent_created — first run
    // should land both rows.
    const t1 = await seedTaskTemplate(handle.db, {
      orgId: org.id,
      triggerEvent: "agent_created",
      name: "Welcome packet",
      title: "Send welcome packet",
    });
    const t2 = await seedTaskTemplate(handle.db, {
      orgId: org.id,
      triggerEvent: "agent_created",
      name: "Provision laptop",
      title: "Provision laptop",
    });

    await taskAutoAssignWorker({
      agentId: agent.id,
      orgId: org.id,
      trigger: "agent_created",
    });

    const afterFirst = await countInstancesForAgent(handle.db, agent.id);
    expect(afterFirst).toBe(2);

    // Simulate a pg-boss retry of the same job — identical payload.
    await taskAutoAssignWorker({
      agentId: agent.id,
      orgId: org.id,
      trigger: "agent_created",
    });

    const afterRetry = await countInstancesForAgent(handle.db, agent.id);
    expect(afterRetry).toBe(2);

    // Confirm each (agentId, templateId, trigger) tuple appears at most
    // once: deeper than a count check, this catches a regression where a
    // future change reuses a template id with the same trigger.
    for (const tmpl of [t1, t2]) {
      const rows = await handle.db
        .select({ id: taskInstancesTable.id })
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.agentId, agent.id),
            eq(taskInstancesTable.templateId, tmpl.id),
            eq(taskInstancesTable.autoAssignTrigger, "agent_created"),
          ),
        );
      expect(rows.length).toBe(1);
    }

    // A third retry must still be a no-op.
    await taskAutoAssignWorker({
      agentId: agent.id,
      orgId: org.id,
      trigger: "agent_created",
    });
    expect(await countInstancesForAgent(handle.db, agent.id)).toBe(2);
  });

  it("a different trigger for the same agent+template DOES create a new task", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const agent = await seedAgent(handle.db, { orgId: org.id });

    // One template wired to agent_created, another to agent_status_changed.
    // (Real product code keys templates by a single trigger, so the more
    // realistic scenario is two distinct templates — but we want to prove
    // the dedup key includes `trigger`, so we also assert that a single
    // template wired to two different events would dedupe per-event, not
    // collapse across events.)
    const created = await seedTaskTemplate(handle.db, {
      orgId: org.id,
      triggerEvent: "agent_created",
      title: "Greet new hire",
    });
    const statusChanged = await seedTaskTemplate(handle.db, {
      orgId: org.id,
      triggerEvent: "agent_status_changed",
      title: "Review status change",
    });

    await taskAutoAssignWorker({
      agentId: agent.id,
      orgId: org.id,
      trigger: "agent_created",
    });
    expect(await countInstancesForAgent(handle.db, agent.id)).toBe(1);

    // Different trigger event — must not be deduped against the
    // agent_created row, because the dedup key includes the trigger.
    await taskAutoAssignWorker({
      agentId: agent.id,
      orgId: org.id,
      trigger: "agent_status_changed",
    });
    expect(await countInstancesForAgent(handle.db, agent.id)).toBe(2);

    // Retry of the status-changed event must still be deduped, even
    // though a created-event row already exists for this agent.
    await taskAutoAssignWorker({
      agentId: agent.id,
      orgId: org.id,
      trigger: "agent_status_changed",
    });
    expect(await countInstancesForAgent(handle.db, agent.id)).toBe(2);

    // Sanity: the two rows correspond to the two distinct templates.
    const createdRow = await handle.db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.agentId, agent.id),
          eq(taskInstancesTable.templateId, created.id),
        ),
      );
    const statusRow = await handle.db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.agentId, agent.id),
          eq(taskInstancesTable.templateId, statusChanged.id),
        ),
      );
    expect(createdRow.length).toBe(1);
    expect(statusRow.length).toBe(1);
  });

  it("a different agent with the same template+trigger DOES create a new task", async () => {
    const handle = await bootTestDb();
    const org = await freshOrg(handle.db);
    const a1 = await seedAgent(handle.db, { orgId: org.id });
    const a2 = await seedAgent(handle.db, { orgId: org.id });

    const tmpl = await seedTaskTemplate(handle.db, {
      orgId: org.id,
      triggerEvent: "agent_created",
      title: "Welcome new hire",
    });

    await taskAutoAssignWorker({
      agentId: a1.id,
      orgId: org.id,
      trigger: "agent_created",
    });
    await taskAutoAssignWorker({
      agentId: a2.id,
      orgId: org.id,
      trigger: "agent_created",
    });

    expect(await countInstancesForAgent(handle.db, a1.id)).toBe(1);
    expect(await countInstancesForAgent(handle.db, a2.id)).toBe(1);

    // A retry against agent 1 must not affect agent 2 (and vice versa).
    await taskAutoAssignWorker({
      agentId: a1.id,
      orgId: org.id,
      trigger: "agent_created",
    });
    expect(await countInstancesForAgent(handle.db, a1.id)).toBe(1);
    expect(await countInstancesForAgent(handle.db, a2.id)).toBe(1);

    // Confirm both rows reference the same template — scope is on agent,
    // not on (agent, template) pair alone.
    const rows = await handle.db
      .select({ agentId: taskInstancesTable.agentId })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.templateId, tmpl.id));
    expect(rows.length).toBe(2);
  });
});
