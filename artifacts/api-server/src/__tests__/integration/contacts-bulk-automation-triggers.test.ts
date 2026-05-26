/**
 * Integration tests for B1: bulk set_status / assign_agent now enqueue
 * the same RUN_AUTOMATION_RULES jobs as the single-contact PATCH path.
 *
 * Previously the bulk handler updated rows in Postgres but did not fan
 * out automation triggers — so bulk operations silently bypassed every
 * `contact_status_changed` / `contact_assigned` rule. These tests assert:
 *
 *   1. bulk set_status on N contacts → N RUN_AUTOMATION_RULES jobs with
 *      trigger=contact_status_changed (and the right per-contact ids).
 *   2. bulk set_status skips contacts whose status didn't change.
 *   3. bulk assign_agent on N contacts → N jobs with
 *      trigger=contact_assigned.
 *   4. An enqueue() failure on one contact does NOT abort the bulk
 *      operation — the DB UPDATE still happens, the bulk response is 200.
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

import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";

import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;

let handle: TestDbHandle;
let org: { id: string };
let admin: { id: string };
let agent: { id: string };

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "bulk-auto-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  agent = await seedAgent(handle.db, { orgId: org.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("POST /api/contacts/bulk — automation trigger fan-out", () => {
  it("bulk set_status enqueues one contact_status_changed job per affected contact", async () => {
    const contacts = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        seedContact(handle.db, {
          orgId: org.id,
          firstName: `BulkStatus${i}`,
          status: "lead",
        }),
      ),
    );
    const ids = contacts.map((c) => c.id);

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids, action: "set_status", payload: { status: "prospect" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affected: 3 });

    const jobs = getEnqueuedJobs().filter(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "contact_status_changed",
    );
    expect(jobs).toHaveLength(3);

    const enqueuedIds = jobs
      .map((j) => (j.data as { resourceId: string }).resourceId)
      .sort();
    expect(enqueuedIds).toEqual([...ids].sort());

    for (const job of jobs) {
      const payload = job.data as {
        orgId: string;
        trigger: string;
        resourceType: string;
        context: { oldStatus: string; newStatus: string };
      };
      expect(payload.orgId).toBe(org.id);
      expect(payload.resourceType).toBe("contact");
      expect(payload.context.oldStatus).toBe("lead");
      expect(payload.context.newStatus).toBe("prospect");
    }
  });

  it("bulk set_status skips contacts whose status is already the target status", async () => {
    const noChange = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "NoChange",
      status: "lead",
    });
    const willChange = await seedContact(handle.db, {
      orgId: org.id,
      firstName: "WillChange",
      status: "prospect",
    });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({
        ids: [noChange.id, willChange.id],
        action: "set_status",
        payload: { status: "lead" }, // matches noChange's existing status
      });

    expect(res.status).toBe(200);

    const jobs = getEnqueuedJobs().filter(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "contact_status_changed",
    );
    expect(jobs).toHaveLength(1);
    expect((jobs[0].data as { resourceId: string }).resourceId).toBe(
      willChange.id,
    );
  });

  it("bulk assign_agent enqueues one contact_assigned job per affected contact", async () => {
    const contacts = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        seedContact(handle.db, {
          orgId: org.id,
          firstName: `BulkAssign${i}`,
          status: "lead",
        }),
      ),
    );
    const ids = contacts.map((c) => c.id);

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids, action: "assign_agent", payload: { agentId: agent.id } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affected: 4 });

    const jobs = getEnqueuedJobs().filter(
      (j) =>
        j.name === "run-automation-rules" &&
        (j.data as { trigger: string }).trigger === "contact_assigned",
    );
    expect(jobs).toHaveLength(4);

    const enqueuedIds = jobs
      .map((j) => (j.data as { resourceId: string }).resourceId)
      .sort();
    expect(enqueuedIds).toEqual([...ids].sort());

    for (const job of jobs) {
      const payload = job.data as {
        context: { newAssignedAgentId: string };
      };
      expect(payload.context.newAssignedAgentId).toBe(agent.id);
    }
  });

  it("enqueue failure on one contact does not break the bulk operation", async () => {
    // Spy on the jobs module to make the *third* enqueue call reject.
    const jobsMod = await import("../../lib/jobs");
    const originalEnqueue = jobsMod.enqueue;
    let callIdx = 0;
    const spy = vi
      .spyOn(jobsMod, "enqueue")
      .mockImplementation(async (...args) => {
        callIdx++;
        if (callIdx === 3) {
          throw new Error("simulated pg-boss enqueue failure");
        }
        // Delegate to the test-harness recorder for the rest.
        return originalEnqueue(...args);
      });

    try {
      const contacts = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          seedContact(handle.db, {
            orgId: org.id,
            firstName: `BulkFail${i}`,
            status: "lead",
          }),
        ),
      );
      const ids = contacts.map((c) => c.id);

      const res = await request(app)
        .post("/api/contacts/bulk")
        .set(withAuth(admin.id))
        .send({ ids, action: "set_status", payload: { status: "prospect" } });

      // Bulk operation succeeds end-to-end despite the failed enqueue.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ affected: 5 });
    } finally {
      spy.mockRestore();
    }
  });
});
