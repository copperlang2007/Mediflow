/**
 * Phase 6 — reconciliation + missed-webhook recovery (spec §5.4, §10).
 *
 * Exit criterion: "failure/missed-webhook recovery verified" — a ticket whose
 * terminal lifecycle webhook was missed is reconciled from the dialer's
 * `GET /calls/{id}`, applied ONCE, and audited; reconciliation and the late
 * webhook do NOT double-apply.
 *
 * The dialer is mocked at the read-client HTTP boundary (injected), returning
 * authoritative call state for a `dialerCallId`. The db is a real pglite handle
 * so the conditional-UPDATE terminal-state guard is exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";

// reconcile.ts / terminalOutcome.ts statically import `@workspace/db`, whose
// module-load guard requires DATABASE_URL. This suite injects a pglite handle
// and never queries the real node-postgres pool, so a dummy URL satisfies the
// guard. `vi.hoisted` runs before the static imports below.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
});

import {
  setupTestDb,
  teardownTestDb,
  seedOrg,
  type TestDbHandle,
  type TestDb,
} from "../helpers/testDb";
import * as schema from "@workspace/db/schema";
import {
  DialerReadClient,
  type ReadHttpClient,
  type DialerCallState,
} from "../../lib/dialer/readClient";
import { reconcileStuckTickets } from "../../lib/dialer/reconcile";
import { applyTerminalOutcome } from "../../lib/dialer/terminalOutcome";

function makeKeypair(): { privateKey: string } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Mock dialer GET /calls/{id}: returns the call state keyed by dialerCallId. */
function mockReadClient(
  states: Map<string, DialerCallState>,
  captured: Captured[],
): ReadHttpClient {
  return async (url, init) => {
    captured.push({ url, method: init.method, headers: init.headers });
    // Extract the trailing id segment.
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    const state = states.get(id);
    if (!state) {
      return { status: 404, json: async () => ({ error: "not found" }) };
    }
    return { status: 200, json: async () => state };
  };
}

let handle: TestDbHandle;
let db: TestDb;
const { privateKey } = makeKeypair();

beforeAll(async () => {
  handle = await setupTestDb();
  db = handle.db;
});

afterAll(async () => {
  await teardownTestDb(handle);
});

// A stale `updated_at` so every seeded ticket is past the staleness window.
const STALE = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
const NOW = new Date();

async function seedTicket(opts: {
  orgId: string;
  status: string;
  dialerCallId?: string | null;
  updatedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.dialTicketsTable).values({
    id,
    orgId: opts.orgId,
    status: opts.status,
    dialerCallId: opts.dialerCallId ?? null,
    createdAt: STALE,
    updatedAt: opts.updatedAt ?? STALE,
  });
  return id;
}

function makeReadClient(
  states: Map<string, DialerCallState>,
  captured: Captured[],
): DialerReadClient {
  return new DialerReadClient({
    dialerBaseUrl: "https://dialer.internal/",
    signingPrivateKey: privateKey,
    httpClient: mockReadClient(states, captured),
    nowMs: () => NOW.getTime(),
  });
}

async function getTicket(id: string) {
  const [t] = await db
    .select()
    .from(schema.dialTicketsTable)
    .where(eq(schema.dialTicketsTable.id, id));
  return t;
}

async function outcomeAudits(orgId: string, ticketId: string) {
  return db
    .select()
    .from(schema.auditLogTable)
    .where(
      and(
        eq(schema.auditLogTable.orgId, orgId),
        eq(schema.auditLogTable.resourceType, "dial_ticket_outcome"),
        eq(schema.auditLogTable.resourceId, ticketId),
      ),
    );
}

describe("Dialer reconciliation — missed-webhook recovery (§5.4)", () => {
  let orgId: string;
  beforeEach(async () => {
    // The reconciliation scan is global (cross-org), so clear the ledger
    // between tests to keep each `scanned` count isolated.
    await db.delete(schema.dialTicketsTable);
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    orgId = org.id;
  });

  it("recovers a missed call.completed: applies COMPLETED once, stamps reconciledAt, audits", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket({
      orgId,
      status: "CALLING",
      dialerCallId: callId,
    });
    const states = new Map<string, DialerCallState>([
      [callId, { status: "COMPLETED", duration: 73, endedReason: "HANGUP" }],
    ]);
    const captured: Captured[] = [];
    const readClient = makeReadClient(states, captured);

    const summary = await reconcileStuckTickets({
      db,
      readClient,
      stalenessMinutes: 30,
      now: () => NOW,
    });

    expect(summary.scanned).toBe(1);
    expect(summary.reconciled).toBe(1);

    // The read client called GET /dialer/v1/calls/{id} with a Bearer JWT.
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toContain(`/dialer/v1/calls/${callId}`);
    expect(captured[0].headers["Authorization"]).toMatch(/^Bearer /);

    const t = await getTicket(ticketId);
    expect(t.status).toBe("COMPLETED");
    expect(t.reconciledAt).not.toBeNull();

    const audits = await outcomeAudits(orgId, ticketId);
    expect(audits).toHaveLength(1);
    const changes = audits[0].changes as Record<string, unknown>;
    expect(changes.source).toBe("reconciliation");
    expect(changes.recoveredByReconciliation).toBe(true);
    expect(changes.status).toBe("COMPLETED");
  });

  it("recovers a missed call.failed and maps the dialer reason", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket({
      orgId,
      status: "CALLING",
      dialerCallId: callId,
    });
    const states = new Map<string, DialerCallState>([
      [callId, { status: "NO_ANSWER" }],
    ]);
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(states, []),
      now: () => NOW,
    });
    expect(summary.reconciled).toBe(1);
    const t = await getTicket(ticketId);
    expect(t.status).toBe("FAILED");
  });

  it("does NOT double-apply: reconciliation then a late webhook applies once", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket({
      orgId,
      status: "CALLING",
      dialerCallId: callId,
    });
    const states = new Map<string, DialerCallState>([
      [callId, { status: "COMPLETED", duration: 50, endedReason: "HANGUP" }],
    ]);

    // 1) Reconciler recovers the outcome.
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(states, []),
      now: () => NOW,
    });
    expect(summary.reconciled).toBe(1);

    // 2) The "late" webhook arrives afterwards and routes through the SAME
    //    applyTerminalOutcome. The terminal-state guard makes it a no-op.
    const late = await applyTerminalOutcome(
      {
        orgId,
        dialTicketId: ticketId,
        dialerCallId: callId,
        status: "COMPLETED",
        source: "webhook",
        eventId: `evt_${randomUUID()}`,
      },
      db,
    );
    expect(late.applied).toBe(false);
    expect(late.status).toBe("COMPLETED");

    // Exactly ONE outcome audit row — applied once, not twice.
    const audits = await outcomeAudits(orgId, ticketId);
    expect(audits).toHaveLength(1);
  });

  it("does NOT double-apply: webhook first, then reconciliation is a no-op", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket({
      orgId,
      status: "CALLING",
      dialerCallId: callId,
    });

    // 1) Webhook applies the terminal outcome.
    const first = await applyTerminalOutcome(
      {
        orgId,
        dialTicketId: ticketId,
        dialerCallId: callId,
        status: "FAILED",
        source: "webhook",
        eventId: `evt_${randomUUID()}`,
      },
      db,
    );
    expect(first.applied).toBe(true);

    // 2) The reconciler runs later — the ticket is already terminal, so it is
    //    not even selected (status no longer pre-terminal). No second apply.
    const states = new Map<string, DialerCallState>([
      [callId, { status: "FAILED" }],
    ]);
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(states, []),
      now: () => NOW,
    });
    expect(summary.scanned).toBe(0); // already terminal — excluded from scan
    expect(summary.reconciled).toBe(0);

    const t = await getTicket(ticketId);
    expect(t.status).toBe("FAILED");
    expect(t.reconciledAt).toBeNull(); // outcome came from the webhook
  });

  it("leaves a still-in-flight call alone (authoritatively non-terminal)", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket({
      orgId,
      status: "CALLING",
      dialerCallId: callId,
    });
    const states = new Map<string, DialerCallState>([
      [callId, { status: "IN_PROGRESS" }],
    ]);
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(states, []),
      now: () => NOW,
    });
    expect(summary.scanned).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(summary.stillPending).toBe(1);
    const t = await getTicket(ticketId);
    expect(t.status).toBe("CALLING");
  });

  it("counts a 404 (dialer never knew the call) as not_found, no apply", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const ticketId = await seedTicket({
      orgId,
      status: "ISSUED",
      dialerCallId: callId,
    });
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(new Map(), []), // empty → 404
      now: () => NOW,
    });
    expect(summary.scanned).toBe(1);
    expect(summary.notFound).toBe(1);
    expect(summary.reconciled).toBe(0);
    const t = await getTicket(ticketId);
    expect(t.status).toBe("ISSUED"); // untouched
  });

  it("does not chase a fresh (non-stale) ticket", async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    await seedTicket({
      orgId,
      status: "CALLING",
      dialerCallId: callId,
      updatedAt: new Date(), // just updated — within the window
    });
    const states = new Map<string, DialerCallState>([
      [callId, { status: "COMPLETED" }],
    ]);
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(states, []),
      stalenessMinutes: 30,
      now: () => NOW,
    });
    expect(summary.scanned).toBe(0);
  });

  it("skips a ticket with no dialerCallId (no call to GET)", async () => {
    await seedTicket({ orgId, status: "ISSUED", dialerCallId: null });
    const summary = await reconcileStuckTickets({
      db,
      readClient: makeReadClient(new Map(), []),
      now: () => NOW,
    });
    expect(summary.scanned).toBe(0);
  });
});
