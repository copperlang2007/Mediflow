/**
 * Integration test: Twilio inbound SMS webhook idempotency.
 *
 * Twilio retries webhook deliveries on any non-2xx response, and sometimes
 * even on a 2xx if their ACK times out. Without dedupe, every retry inserts
 * a duplicate row in `messages` and re-fires SSE notifications to the
 * assigned agent.
 *
 * The fix is a partial unique index on `messages(provider_message_id)
 * WHERE provider_message_id IS NOT NULL` (migration 0008) plus
 * `onConflictDoNothing` in the inbound handler — the handler then checks
 * `.returning()` to know whether to broadcast.
 *
 * What this file covers:
 *   1. Same `MessageSid` posted twice → exactly one `messages` row.
 *   2. The second POST still returns 200 (Twilio stops retrying).
 *   3. The second POST does NOT re-broadcast SSE.
 *   4. Two different `MessageSid` values → two rows (sanity).
 *   5. Outbound rows with NULL `provider_message_id` can coexist
 *      (partial unique index isn't tripped by NULLs).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const { dbF, clerkF, jobsF, smsF, sseF } = vi.hoisted(() => ({
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
  // Bypass Twilio signature validation so we don't have to recompute an
  // HMAC over urlencoded body params on every request. The dedupe logic
  // is what we actually want to exercise.
  smsF: async (): Promise<Record<string, unknown>> => {
    const actual = await import("../../lib/sms");
    return {
      ...actual,
      validateTwilioWebhookSignature: (): boolean => true,
    };
  },
  // Spy on broadcastToUser so we can assert call counts on retries.
  sseF: async (): Promise<Record<string, unknown>> => {
    const actual = await import("../../lib/sseManager");
    return {
      ...actual,
      broadcastToUser: vi.fn(),
    };
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/sms", smsF);
vi.mock("../../lib/sseManager", sseF);

import {
  bootTestDb,
  shutdownTestDb,
} from "../helpers/testApp";
import {
  seedOrg,
  seedAgent,
  seedContact,
  seedUser,
} from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let broadcastToUser: ReturnType<typeof vi.fn>;
let messagesTable: typeof import("@workspace/db").messagesTable;
let messageThreadsTable: typeof import("@workspace/db").messageThreadsTable;
let contactsTable: typeof import("@workspace/db").contactsTable;
let agentsTable: typeof import("@workspace/db").agentsTable;
let db: import("../helpers/testDb").TestDb;

let orgId: string;
let agentId: string;
let agentUserId: string;
let contactId: string;
const contactPhone = "+15555550100";

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;

  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  const sseManager = await import("../../lib/sseManager");
  broadcastToUser = sseManager.broadcastToUser as ReturnType<typeof vi.fn>;

  const dbExports = await import("@workspace/db");
  messagesTable = dbExports.messagesTable;
  messageThreadsTable = dbExports.messageThreadsTable;
  contactsTable = dbExports.contactsTable;
  agentsTable = dbExports.agentsTable;

  const org = await seedOrg(handle.db, { id: `org-${randomUUID().slice(0, 8)}` });
  orgId = org.id;

  // Need a real user row for SSE lookup. agents.user_id is what the
  // webhook reads to decide whom to notify.
  const user = await seedUser(handle.db, { orgId });
  agentUserId = user.id;

  const agent = await seedAgent(handle.db, { orgId });
  agentId = agent.id;

  // Wire agent.user_id so the webhook's broadcast path actually fires.
  await handle.db
    .update(agentsTable)
    .set({ userId: agentUserId })
    .where(eq(agentsTable.id, agentId));

  // Use seedContact then patch in phone + assignedAgentId via update,
  // since seedContact's options don't expose those.
  const contact = await seedContact(handle.db, { orgId });
  contactId = contact.id;
  await handle.db
    .update(contactsTable)
    .set({ phone: contactPhone, assignedAgentId: agentId })
    .where(eq(contactsTable.id, contactId));
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  broadcastToUser.mockClear();
});

function twilioPayload(messageSid: string, body = "Hi there"): Record<string, string> {
  return {
    From: contactPhone,
    To: "+15555550000",
    Body: body,
    MessageSid: messageSid,
    AccountSid: "ACtest",
  };
}

describe("Twilio inbound SMS webhook — idempotency on retries", () => {
  it("collapses duplicate retries with the same MessageSid into one row", async () => {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;

    const first = await request(app)
      .post("/webhooks/twilio/sms")
      .type("form")
      .set("x-twilio-signature", "dummy")
      .send(twilioPayload(sid));
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/webhooks/twilio/sms")
      .type("form")
      .set("x-twilio-signature", "dummy")
      .send(twilioPayload(sid));
    // Twilio-compatible: still 200 on the retry so they stop trying.
    expect(second.status).toBe(200);

    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.providerMessageId, sid));
    expect(rows).toHaveLength(1);
  });

  it("does not re-broadcast SSE to the assigned agent on the duplicate retry", async () => {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;

    await request(app)
      .post("/webhooks/twilio/sms")
      .type("form")
      .set("x-twilio-signature", "dummy")
      .send(twilioPayload(sid));
    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith(
      agentUserId,
      expect.objectContaining({ type: "inbound_sms", contactId }),
    );

    await request(app)
      .post("/webhooks/twilio/sms")
      .type("form")
      .set("x-twilio-signature", "dummy")
      .send(twilioPayload(sid));
    // Still exactly one broadcast — the retry was suppressed.
    expect(broadcastToUser).toHaveBeenCalledTimes(1);
  });

  it("two different MessageSid values create two distinct rows", async () => {
    const sidA = `SM${randomUUID().replace(/-/g, "")}`;
    const sidB = `SM${randomUUID().replace(/-/g, "")}`;

    await request(app)
      .post("/webhooks/twilio/sms")
      .type("form")
      .set("x-twilio-signature", "dummy")
      .send(twilioPayload(sidA, "first"));
    await request(app)
      .post("/webhooks/twilio/sms")
      .type("form")
      .set("x-twilio-signature", "dummy")
      .send(twilioPayload(sidB, "second"));

    const rowsA = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.providerMessageId, sidA));
    const rowsB = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.providerMessageId, sidB));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
  });

  it("partial unique index allows multiple outbound rows with NULL provider_message_id", async () => {
    // Find (or create) the SMS thread for this contact — the previous
    // inbound tests have likely already created one.
    let [thread] = await db
      .select()
      .from(messageThreadsTable)
      .where(eq(messageThreadsTable.contactId, contactId));
    if (!thread) {
      [thread] = await db
        .insert(messageThreadsTable)
        .values({
          id: randomUUID(),
          orgId,
          contactId,
          channel: "sms",
          lastMessageAt: new Date(),
        })
        .returning();
    }

    // Two outbound rows, both with provider_message_id = NULL.
    await db.insert(messagesTable).values({
      id: randomUUID(),
      threadId: thread.id,
      direction: "outbound",
      body: "outbound 1",
      status: "queued",
      toAddress: contactPhone,
    });
    await db.insert(messagesTable).values({
      id: randomUUID(),
      threadId: thread.id,
      direction: "outbound",
      body: "outbound 2",
      status: "queued",
      toAddress: contactPhone,
    });

    // If the unique index were not partial these inserts would collide.
    // Simply having both rows present is the assertion.
    const outboundRows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.direction, "outbound"));
    expect(outboundRows.length).toBeGreaterThanOrEqual(2);
    expect(outboundRows.every((r) => r.providerMessageId === null)).toBe(true);
  });
});
