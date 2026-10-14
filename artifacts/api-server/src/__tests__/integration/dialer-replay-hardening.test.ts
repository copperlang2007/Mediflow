/**
 * Phase 6 — idempotency + replay hardening (spec §6.2, §10).
 *
 * Proves the inbound event path is replay-safe and that the webhook and the
 * reconciliation job converge on a single terminal application:
 *
 *   1. A duplicate terminal webhook applies the outcome exactly once
 *      (eventId ledger dedup + terminal-state guard).
 *   2. A stale-timestamp delivery is rejected (HMAC ±5 min window, §4.2) —
 *      replay defence.
 *   3. An out-of-order terminal event is applied once: a SECOND, different
 *      terminal event (e.g. call.failed after call.completed) does not flip
 *      an already-terminal ticket.
 *   4. A duplicate webhook FOLLOWED BY reconciliation of the same call does
 *      not double-process.
 *
 * These run against the REAL receiver route (`POST /api/dialer/v1/events`),
 * signing events with the shared secret the route resolves — the real wire
 * contract — plus the in-process reconciler against the same pglite db.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";

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

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg } from "../helpers/testDb";
import type { Express } from "express";
import type { TestDb } from "../helpers/testDb";
// readClient.ts has no `@workspace/db` import, so it is safe to import
// statically. `reconcile.ts` DOES import `@workspace/db` (mocked here) and so
// is imported dynamically AFTER bootTestDb().
import {
  DialerReadClient,
  type ReadHttpClient,
  type DialerCallState,
} from "../../lib/dialer/readClient";
type ReconcileFn = typeof import("../../lib/dialer/reconcile").reconcileStuckTickets;

const SECRET = "test-dialer-shared-secret";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let db: TestDb;
let reconcileStuckTickets: ReconcileFn;
let dialTicketsTable: typeof import("@workspace/db").dialTicketsTable;
let auditLogTable: typeof import("@workspace/db").auditLogTable;

beforeAll(async () => {
  process.env.DIALER_WEBHOOK_SECRET = SECRET;
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;
  const dbExports = await import("@workspace/db");
  dialTicketsTable = dbExports.dialTicketsTable;
  auditLogTable = dbExports.auditLogTable;
  reconcileStuckTickets = (await import("../../lib/dialer/reconcile"))
    .reconcileStuckTickets;
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
  type: string;
  orgId: string;
  eventId?: string;
  dialTicketId?: string;
  dialerCallId?: string;
  data?: Record<string, unknown>;
}

function buildEvent(opts: EventOpts): { raw: string; eventId: string } {
  const eventId = opts.eventId ?? `evt_${randomUUID()}`;
  const envelope: Record<string, unknown> = {
    eventId,
    schemaVersion: 1,
    type: opts.type,
    occurredAt: new Date().toISOString(),
    orgId: opts.orgId,
    ...(opts.dialTicketId ? { dialTicketId: opts.dialTicketId } : {}),
    ...(opts.dialerCallId ? { dialerCallId: opts.dialerCallId } : {}),
    data: opts.data ?? {},
  };
  return { raw: JSON.stringify(envelope), eventId };
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

async function seedTicket(orgId: string, dialerCallId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(dialTicketsTable).values({
    id,
    orgId,
    status: "CALLING",
    dialerCallId,
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  return id;
}

async function outcomeAudits(orgId: string, ticketId: string) {
  return db
    .select()
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.orgId, orgId),
        eq(auditLogTable.resourceType, "dial_ticket_outcome"),
        eq(auditLogTable.resourceId, ticketId),
      ),
    );
}

function mockReadClient(states: Map<string, DialerCallState>): ReadHttpClient {
  return async (url) => {
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    const state = states.get(id);
    if (!state) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => state };
  };
}

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("Phase 6 — replay/idempotency hardening (§6.2)", () => {
  it("applies a duplicate terminal webhook exactly once", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket(org.id, callId);
    const { raw } = buildEvent({
      orgId: org.id,
      type: "call.completed",
      dialTicketId: ticketId,
      dialerCallId: callId,
      data: { duration: 30, endedReason: "HANGUP" },
    });
    const sig = sign(raw);

    const first = await postEvent(raw, sig);
    const second = await postEvent(raw, sig);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "accepted" });
    // Same eventId → deduped at the ledger; handler does not run twice.
    expect(second.body).toMatchObject({ status: "duplicate" });

    const [t] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(t.status).toBe("COMPLETED");

    const audits = await outcomeAudits(org.id, ticketId);
    expect(audits).toHaveLength(1);
  });

  it("rejects a stale-timestamp delivery (replay defence, §4.2)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const { raw } = buildEvent({ orgId: org.id, type: "call.completed" });
    const stale = Math.floor(Date.now() / 1000) - 10 * 60; // 10 min ago
    const res = await postEvent(raw, sign(raw, stale));
    expect(res.status).toBe(403);
  });

  it("handles an out-of-order terminal event once (call.failed after call.completed)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket(org.id, callId);

    // First: call.completed (distinct eventId).
    const completed = buildEvent({
      orgId: org.id,
      type: "call.completed",
      dialTicketId: ticketId,
      dialerCallId: callId,
      data: { duration: 42, endedReason: "HANGUP" },
    });
    const r1 = await postEvent(completed.raw, sign(completed.raw));
    expect(r1.status).toBe(200);

    // Then: a LATE, DIFFERENT terminal event (call.failed, different eventId).
    // The eventId ledger does NOT dedup it — but the terminal-state guard does.
    const failed = buildEvent({
      orgId: org.id,
      type: "call.failed",
      dialTicketId: ticketId,
      dialerCallId: callId,
      data: { reason: "FAILED" },
    });
    const r2 = await postEvent(failed.raw, sign(failed.raw));
    expect(r2.status).toBe(200);

    const [t] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    // Stays COMPLETED — the late call.failed did not flip it.
    expect(t.status).toBe("COMPLETED");

    const audits = await outcomeAudits(org.id, ticketId);
    expect(audits).toHaveLength(1);
  });

  it("duplicate webhook + reconciliation of the same call do not double-process", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket(org.id, callId);

    const { raw } = buildEvent({
      orgId: org.id,
      type: "call.completed",
      dialTicketId: ticketId,
      dialerCallId: callId,
      data: { duration: 55, endedReason: "HANGUP" },
    });
    const sig = sign(raw);

    // Webhook delivered twice (duplicate).
    await postEvent(raw, sig);
    await postEvent(raw, sig);

    // Reconciler runs afterwards (e.g. it had queued this ticket before the
    // webhook landed). The ticket is already terminal → not even selected.
    const states = new Map<string, DialerCallState>([
      [callId, { status: "COMPLETED", duration: 55, endedReason: "HANGUP" }],
    ]);
    const readClient = new DialerReadClient({
      dialerBaseUrl: "https://dialer.internal",
      signingPrivateKey: privateKey,
      httpClient: mockReadClient(states),
    });
    const summary = await reconcileStuckTickets({ db, readClient });
    expect(summary.reconciled).toBe(0);

    const [t] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(t.status).toBe("COMPLETED");
    expect(t.reconciledAt).toBeNull(); // outcome came from the webhook, once

    const audits = await outcomeAudits(org.id, ticketId);
    expect(audits).toHaveLength(1);
  });
});
