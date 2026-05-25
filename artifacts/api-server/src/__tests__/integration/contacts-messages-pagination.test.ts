/**
 * Integration test for B2: GET /contacts/:id/messages now returns a
 * real count() and accepts ?offset.
 *
 * Previously the route returned `total: rows.length` (a lie — really
 * just the page size) and had no `offset` param, so contacts with > 100
 * messages were silently truncated. We mirror the /contacts/:id/threads
 * pattern from PR #82: default limit 100, hard cap 500, real count
 * query in parallel, `{ data, total, limit, offset }` envelope.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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

import { randomUUID } from "node:crypto";
import { messagesTable, messageThreadsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";

import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;

let handle: TestDbHandle;
let org: { id: string };
let admin: { id: string };
let contact: { id: string };

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "msg-pag-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  contact = await seedContact(handle.db, {
    orgId: org.id,
    firstName: "MsgPag",
    status: "lead",
  });

  // Single thread, 150 messages — exercises the > default-limit case.
  const threadId = randomUUID();
  await handle.db.insert(messageThreadsTable).values({
    id: threadId,
    orgId: org.id,
    contactId: contact.id,
    channel: "sms",
    lastMessageAt: new Date(),
  });

  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: randomUUID(),
    threadId,
    direction: "inbound" as const,
    body: `msg-${i.toString().padStart(3, "0")}`,
    status: "received" as const,
    // Spread createdAt so the ORDER BY is deterministic.
    createdAt: new Date(Date.now() - (150 - i) * 1000),
    sentAt: new Date(Date.now() - (150 - i) * 1000),
  }));
  await handle.db.insert(messagesTable).values(rows);
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /api/contacts/:id/messages — pagination", () => {
  it("default request returns 100 rows and the real total", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/messages`)
      .set(withAuth(admin.id));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(150);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.messages).toHaveLength(100);
    expect(res.body.data).toHaveLength(100);
  });

  it("?offset=100 returns the remaining 50 rows", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/messages?offset=100`)
      .set(withAuth(admin.id));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(150);
    expect(res.body.offset).toBe(100);
    expect(res.body.messages).toHaveLength(50);
  });

  it("?limit=99999 clamps to 500", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/messages?limit=99999`)
      .set(withAuth(admin.id));

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    // We only have 150 messages, so length is 150 — but the limit cap
    // is what we're really asserting.
    expect(res.body.messages.length).toBeLessThanOrEqual(500);
  });

  it("returns 404 for a non-existent contact id", async () => {
    const res = await request(app)
      .get(`/api/contacts/does-not-exist/messages`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });
});
