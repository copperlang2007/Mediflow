/**
 * Contract tests — inbound dialer event receiver (spec §6).
 *
 * Covers the Phase-2 exit criterion ("contract tests pass against a mock
 * dialer") for the webhook side:
 *   - valid signed event accepted + audited
 *   - bad signature rejected (401)
 *   - stale timestamp rejected (403)
 *   - duplicate eventId deduped (handler runs once)
 *   - unknown event type tolerated (forward-compat, §6.2)
 *   - call.transcript.purged hash verification (§6.1)
 *
 * The dialer is mocked by SIGNING events with the same shared secret the
 * route resolves from the environment — exactly the wire contract the real
 * masterBRIDGE side emits.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";

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

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";
import type { TestDb } from "../helpers/testDb";

const SECRET = "test-dialer-shared-secret";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let db: TestDb;
let dialerEventsTable: typeof import("@workspace/db").dialerEventsTable;
let dialTicketsTable: typeof import("@workspace/db").dialTicketsTable;
let auditLogTable: typeof import("@workspace/db").auditLogTable;
let taskInstancesTable: typeof import("@workspace/db").taskInstancesTable;

beforeAll(async () => {
  process.env.DIALER_WEBHOOK_SECRET = SECRET;
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;
  const dbExports = await import("@workspace/db");
  dialerEventsTable = dbExports.dialerEventsTable;
  dialTicketsTable = dbExports.dialTicketsTable;
  auditLogTable = dbExports.auditLogTable;
  taskInstancesTable = dbExports.taskInstancesTable;
});

afterAll(async () => {
  delete process.env.DIALER_WEBHOOK_SECRET;
  await shutdownTestDb();
});

function sign(rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto
    .createHmac("sha256", SECRET)
    .update(`${t}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

interface EventOpts {
  type?: string;
  orgId: string;
  eventId?: string;
  dialTicketId?: string;
  dialerCallId?: string;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function buildEvent(opts: EventOpts): {
  raw: string;
  envelope: Record<string, unknown>;
} {
  const envelope: Record<string, unknown> = {
    eventId: opts.eventId ?? `evt_${randomUUID()}`,
    schemaVersion: 1,
    type: opts.type ?? "call.completed",
    occurredAt: new Date().toISOString(),
    orgId: opts.orgId,
    ...(opts.dialTicketId ? { dialTicketId: opts.dialTicketId } : {}),
    ...(opts.dialerCallId ? { dialerCallId: opts.dialerCallId } : {}),
    data: opts.data ?? {},
    ...(opts.extra ?? {}),
  };
  return { raw: JSON.stringify(envelope), envelope };
}

async function postEvent(
  raw: string,
  signature: string | null,
): Promise<{ status: number; body: unknown }> {
  let req = request(app)
    .post("/api/dialer/v1/events")
    .set("Content-Type", "application/json");
  if (signature !== null) req = req.set("X-MB-Signature", signature);
  const res = await req.send(raw);
  return { status: res.status, body: res.body };
}

describe("Dialer event receiver — signature + audit", () => {
  it("accepts a validly signed event and audits it", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const { raw, envelope } = buildEvent({
      orgId: org.id,
      type: "call.completed",
      data: { duration: 42, endedReason: "COMPLETED" },
    });

    const res = await postEvent(raw, sign(raw));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "accepted" });

    // Landed in the dialer_events ledger.
    const rows = await db
      .select()
      .from(dialerEventsTable)
      .where(eq(dialerEventsTable.id, envelope.eventId as string));
    expect(rows).toHaveLength(1);

    // Landed in the audit log.
    const audit = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, org.id),
          eq(auditLogTable.resourceType, "dialer_event"),
          eq(auditLogTable.resourceId, envelope.eventId as string),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it("rejects an event with a bad signature (401)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const { raw } = buildEvent({ orgId: org.id });
    const t = Math.floor(Date.now() / 1000);
    const res = await postEvent(raw, `t=${t},v1=deadbeef`);
    expect(res.status).toBe(401);
  });

  it("rejects an event with no signature header (401)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const { raw } = buildEvent({ orgId: org.id });
    const res = await postEvent(raw, null);
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp (403)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const { raw } = buildEvent({ orgId: org.id });
    // 10 minutes in the past — beyond the ±5 min window.
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await postEvent(raw, sign(raw, stale));
    expect(res.status).toBe(403);
  });

  it("dedupes a duplicate eventId (handler runs once)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const eventId = `evt_${randomUUID()}`;
    const { raw } = buildEvent({
      orgId: org.id,
      eventId,
      type: "call.completed",
    });
    const sig = sign(raw);

    const first = await postEvent(raw, sig);
    const second = await postEvent(raw, sig);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "accepted" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "duplicate" });

    // Exactly one ledger row, exactly one audit row.
    const rows = await db
      .select()
      .from(dialerEventsTable)
      .where(eq(dialerEventsTable.id, eventId));
    expect(rows).toHaveLength(1);
    const audit = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.resourceId, eventId));
    expect(audit).toHaveLength(1);
  });

  it("tolerates an unknown event type (forward-compat, §6.2)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const { raw, envelope } = buildEvent({
      orgId: org.id,
      type: "call.future.unknown_type",
      // unknown top-level + unknown data fields must be ignored, not error
      extra: { someBrandNewField: true },
      data: { whatever: 1, nested: { deep: "x" } },
    });
    const res = await postEvent(raw, sign(raw));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ignored" });

    // Still recorded + audited even though the type is unknown.
    const rows = await db
      .select()
      .from(dialerEventsTable)
      .where(eq(dialerEventsTable.id, envelope.eventId as string));
    expect(rows).toHaveLength(1);
  });
});

describe("Dialer event receiver — transcript purge (§6.1)", () => {
  async function seedTicket(orgId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(dialTicketsTable).values({ id, orgId, status: "ISSUED" });
    return id;
  }

  it("confirms purge when the transcript hash matches", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const transcript = "Hello, this is your Medicare agent calling.";
    const hash = crypto
      .createHash("sha256")
      .update(transcript, "utf8")
      .digest("hex");

    // 1) transcript.ready records the hash on the ticket.
    const ready = buildEvent({
      orgId: org.id,
      type: "call.transcript.ready",
      dialTicketId: ticketId,
      data: { transcriptText: transcript, redacted: false },
    });
    const r1 = await postEvent(ready.raw, sign(ready.raw));
    expect(r1.status).toBe(200);

    // 2) transcript.purged with the matching hash → confirmed timestamp set.
    const purged = buildEvent({
      orgId: org.id,
      type: "call.transcript.purged",
      dialTicketId: ticketId,
      data: { purgedAt: new Date().toISOString(), transcriptHash: hash },
    });
    const r2 = await postEvent(purged.raw, sign(purged.raw));
    expect(r2.status).toBe(200);

    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(ticket?.transcriptHash).toBe(hash);
    expect(ticket?.transcriptPurgeConfirmedAt).not.toBeNull();
  });

  it("does NOT confirm purge when the transcript hash mismatches", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const transcript = "Original transcript text.";

    const ready = buildEvent({
      orgId: org.id,
      type: "call.transcript.ready",
      dialTicketId: ticketId,
      data: { transcriptText: transcript },
    });
    await postEvent(ready.raw, sign(ready.raw));

    const purged = buildEvent({
      orgId: org.id,
      type: "call.transcript.purged",
      dialTicketId: ticketId,
      data: {
        purgedAt: new Date().toISOString(),
        transcriptHash: "0".repeat(64), // wrong hash
      },
    });
    const r2 = await postEvent(purged.raw, sign(purged.raw));
    // Acked (so the dialer stops retrying) but NOT confirmed.
    expect(r2.status).toBe(200);

    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(ticket?.transcriptPurgeConfirmedAt).toBeNull();
  });
});

describe("Dialer event receiver — compliance oversight tasks (Phase 4, §6)", () => {
  it("raises an oversight task for a COMPLIANCE-category disposition, assigned to the compliance manager", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const cm = await seedUser(db, {
      orgId: org.id,
      role: "compliance_manager",
    });
    const { raw, envelope } = buildEvent({
      orgId: org.id,
      type: "call.disposition.recorded",
      dialerCallId: `call_${randomUUID().slice(0, 8)}`,
      data: {
        code: "DNC_REQUEST",
        category: "COMPLIANCE",
        notes: "Caller asked to be placed on the do-not-call list.",
      },
    });
    const res = await postEvent(raw, sign(raw));
    expect(res.status).toBe(200);

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("open");
    expect(tasks[0].priority).toBe("urgent");
    expect(tasks[0].assignedToUserId).toBe(cm.id);
    expect(tasks[0].title.toLowerCase()).toContain("compliance");

    // Audited as a compliance oversight task.
    const audit = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, org.id),
          eq(auditLogTable.resourceType, "compliance_oversight_task"),
          eq(auditLogTable.resourceId, tasks[0].id),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(
      (audit[0].changes as Record<string, unknown>).eventId,
    ).toBe(envelope.eventId);
  });

  it("does NOT raise a task for a non-compliance disposition", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    await seedUser(db, { orgId: org.id, role: "compliance_manager" });
    const { raw } = buildEvent({
      orgId: org.id,
      type: "call.disposition.recorded",
      data: { code: "SALE", category: "POSITIVE", notes: "enrolled" },
    });
    const res = await postEvent(raw, sign(raw));
    expect(res.status).toBe(200);

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(0);
  });

  it("raises an oversight task for call.compliance.flagged", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    await seedUser(db, { orgId: org.id, role: "agency_admin" });
    const { raw } = buildEvent({
      orgId: org.id,
      type: "call.compliance.flagged",
      data: { rule: "DNC", detail: "number on the federal DNC registry" },
    });
    const res = await postEvent(raw, sign(raw));
    expect(res.status).toBe(200);

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(1);
    // Falls back to agency_admin when no compliance_manager exists.
    expect(tasks[0].assignedToUserId).not.toBeNull();
  });
});
