/**
 * Silent-failure path coverage: fire-and-forget `enqueue(...)` calls in
 * HTTP routes attach a `.catch` so a wedged pg-boss / flaky network does
 * not break the user-facing operation and does not silently swallow the
 * rejection. Operators get a `logger.warn` entry tagged with the job name
 * and the relevant record IDs.
 *
 * The route under test (POST /contacts) intentionally returns 201 even if
 * the downstream automation enqueue rejects — the contact is persisted
 * and the surfacing of the queue failure is logging's job, not the
 * request handler's.
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

import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
} from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let jobsModule: typeof import("../../lib/jobs");
let loggerModule: typeof import("../../lib/logger");

let org: { id: string };
let admin: { id: string };

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = (await import("supertest") as any).default;
  jobsModule = await import("../../lib/jobs");
  loggerModule = await import("../../lib/logger");

  const handle = await bootTestDb();
  org = await seedOrg(handle.db, { id: "enqueue-fail-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fire-and-forget enqueue() rejections are logged, not swallowed", () => {
  it("POST /contacts still returns 201 when enqueue rejects, and logs a warning with context", async () => {
    const boom = new Error("pg-boss wedged");
    // Force the next enqueue call to reject. The route's .catch must
    // handle it; otherwise we'd see an UnhandledPromiseRejection (which
    // would crash the test runner) and/or a non-201 response.
    const enqueueSpy = vi
      .spyOn(jobsModule, "enqueue")
      .mockRejectedValueOnce(boom);
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");

    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(admin.id))
      .send({
        firstName: "Async",
        lastName: "Failure",
        email: "async-failure@example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    // Give the rejection a tick to propagate into the .catch handler so
    // logger.warn fires before we assert on it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: boom,
        jobName: "run-automation-rules",
        trigger: "contact_created",
        orgId: org.id,
        contactId: res.body.id,
      }),
      "Failed to enqueue automation job",
    );
  });

  it("POST /leads still returns 201 when enqueue rejects, and logs a warning with leadId/contactId", async () => {
    const boom = new Error("network flake");
    const handle = await bootTestDb();
    // Seed a contact directly so we can attach a lead to it.
    const { seedContact } = await import("../helpers/testDb");
    const contact = await seedContact(handle.db, { orgId: org.id });

    const enqueueSpy = vi
      .spyOn(jobsModule, "enqueue")
      .mockRejectedValueOnce(boom);
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");

    const res = await request(app)
      .post("/api/leads")
      .set(withAuth(admin.id))
      .send({ contactId: contact.id, source: "web" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: boom,
        jobName: "run-automation-rules",
        trigger: "lead_created",
        orgId: org.id,
        leadId: res.body.id,
        contactId: contact.id,
      }),
      "Failed to enqueue automation job",
    );
  });
});
