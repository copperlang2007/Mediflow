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

import { eq, desc } from "drizzle-orm";
import {
  automationRuleLogsTable,
  contactsTable,
  taskInstancesTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  seedContact,
  seedAutomationRule,
} from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
// runWorker invokes the actual automation worker against the pglite db so we
// don't depend on pg-boss to dispatch jobs in tests.
let runWorker: typeof import("../../workers/runAutomationRules").runAutomationRulesWorker;

let org: { id: string };
let admin: { id: string };
let agent: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
  runWorker = (
    await import("../../workers/runAutomationRules")
  ).runAutomationRulesWorker;

  org = await seedOrg(handle.db, { id: "auto-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  agent = await seedAgent(handle.db, { orgId: org.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("Automation rules engine integration", () => {
  it("fires lead_created → change_contact_status when conditions match (source=web)", async () => {
    const handle = await bootTestDb();
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      status: "lead",
    });
    const rule = await seedAutomationRule(handle.db, {
      orgId: org.id,
      triggerType: "lead_created",
      conditions: [{ field: "source", operator: "eq", value: "web" }],
      actions: [
        { type: "change_contact_status", config: { status: "prospect" } },
      ],
    });

    const res = await request(app)
      .post("/api/leads")
      .set(withAuth(admin.id))
      .send({ contactId: contact.id, source: "web" });
    expect(res.status).toBe(201);

    const enqueued = getEnqueuedJobs();
    const job = enqueued.find(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "lead_created",
    );
    expect(job).toBeDefined();

    // Drive the worker synchronously with the same payload pg-boss would have delivered.
    await runWorker(
      job!.data as Parameters<typeof runWorker>[0],
    );

    const [updated] = await handle.db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.status).toBe("prospect");

    const [logRow] = await handle.db
      .select()
      .from(automationRuleLogsTable)
      .where(eq(automationRuleLogsTable.ruleId, rule.id))
      .orderBy(desc(automationRuleLogsTable.executedAt));
    expect(logRow).toBeDefined();
    expect(logRow.result).toBe("success");
    expect(logRow.actionsExecuted).toContain("change_contact_status");
  });

  it("does NOT fire when conditions are not met (source=phone)", async () => {
    const handle = await bootTestDb();
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      status: "lead",
    });
    const rule = await seedAutomationRule(handle.db, {
      orgId: org.id,
      triggerType: "lead_created",
      conditions: [{ field: "source", operator: "eq", value: "web" }],
      actions: [
        { type: "change_contact_status", config: { status: "prospect" } },
      ],
    });

    const res = await request(app)
      .post("/api/leads")
      .set(withAuth(admin.id))
      .send({ contactId: contact.id, source: "phone" });
    expect(res.status).toBe(201);

    const job = getEnqueuedJobs().find(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "lead_created",
    );
    expect(job).toBeDefined();
    await runWorker(job!.data as Parameters<typeof runWorker>[0]);

    const [updated] = await handle.db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    // Status should NOT have flipped.
    expect(updated.status).toBe("lead");

    // The rule's log is only written when conditions match — so no row for this rule.
    const logRows = await handle.db
      .select()
      .from(automationRuleLogsTable)
      .where(eq(automationRuleLogsTable.ruleId, rule.id));
    expect(logRows.length).toBe(0);
  });

  it("evaluates AND conditions across multiple fields", async () => {
    const handle = await bootTestDb();
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      status: "lead",
    });
    // The lead_created enricher copies the lead row's status (default "new")
    // into the context — NOT the contact's status. This rule therefore tests
    // that AND-combined conditions both have to match to fire.
    const rule = await seedAutomationRule(handle.db, {
      orgId: org.id,
      triggerType: "lead_created",
      conditions: [
        { field: "source", operator: "eq", value: "web" },
        { field: "status", operator: "eq", value: "new", logic: "and" },
      ],
      actions: [
        { type: "change_contact_status", config: { status: "prospect" } },
      ],
    });

    const res = await request(app)
      .post("/api/leads")
      .set(withAuth(admin.id))
      .send({ contactId: contact.id, source: "web" });
    expect(res.status).toBe(201);

    const job = getEnqueuedJobs().find(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "lead_created",
    );
    expect(job).toBeDefined();
    await runWorker(job!.data as Parameters<typeof runWorker>[0]);

    const [logRow] = await handle.db
      .select()
      .from(automationRuleLogsTable)
      .where(eq(automationRuleLogsTable.ruleId, rule.id));
    expect(logRow?.result).toBe("success");
  });

  it("fires task_completed trigger when PATCH /tasks/:id flips status to completed", async () => {
    const handle = await bootTestDb();
    const contact = await seedContact(handle.db, { orgId: org.id });

    // A task in the org so we have something to complete.
    const taskId = `task-${Date.now()}`;
    await handle.db.insert(taskInstancesTable).values({
      id: taskId,
      orgId: org.id,
      title: "Test task",
      status: "open",
      priority: "medium",
      agentId: agent.id,
      contactId: contact.id,
    });

    const rule = await seedAutomationRule(handle.db, {
      orgId: org.id,
      triggerType: "task_completed",
      conditions: [],
      actions: [
        {
          type: "create_task",
          config: { title: "Follow-up generated by automation" },
        },
      ],
    });

    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(withAuth(admin.id))
      .send({ status: "completed" });
    expect(res.status).toBe(200);

    const job = getEnqueuedJobs().find(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "task_completed",
    );
    expect(job).toBeDefined();
    await runWorker(job!.data as Parameters<typeof runWorker>[0]);

    const [logRow] = await handle.db
      .select()
      .from(automationRuleLogsTable)
      .where(eq(automationRuleLogsTable.ruleId, rule.id));
    expect(logRow).toBeDefined();
    expect(logRow.result).toBe("success");
    expect(logRow.actionsExecuted).toContain("create_task");

    // The action created a brand-new task in the same org.
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    const generated = tasks.find(
      (t) => t.title === "Follow-up generated by automation",
    );
    expect(generated).toBeDefined();
  });

  it("inactive rules are not evaluated", async () => {
    const handle = await bootTestDb();
    const contact = await seedContact(handle.db, { orgId: org.id });
    const rule = await seedAutomationRule(handle.db, {
      orgId: org.id,
      triggerType: "lead_created",
      conditions: [],
      actions: [
        { type: "change_contact_status", config: { status: "prospect" } },
      ],
      isActive: false,
    });

    await runWorker({
      orgId: org.id,
      trigger: "lead_created",
      resourceType: "contact",
      resourceId: contact.id,
      context: { source: "web" },
    });

    const logRows = await handle.db
      .select()
      .from(automationRuleLogsTable)
      .where(eq(automationRuleLogsTable.ruleId, rule.id));
    expect(logRows.length).toBe(0);
  });
});
