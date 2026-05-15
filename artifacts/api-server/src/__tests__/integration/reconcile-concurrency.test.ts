/**
 * Concurrency guarantees for the commission reconciliation worker.
 *
 * PR #66 made `reconcileStatement` idempotent for SEQUENTIAL retries by
 * snapshotting each line item's contribution into
 * `commission_line_items.payout_contribution` and only applying the diff
 * on re-run. That fix is NOT sufficient for CONCURRENT retries: two
 * workers (operator double-click while pg-boss is still running the
 * first job, retry-on-timeout firing while the original is still alive,
 * CSV re-uploaded mid-reconcile, ...) could both read
 * `payout_contribution = null`, both compute "first credit", and both
 * apply the full amount — re-introducing the exact double-pay bug under
 * a narrower trigger.
 *
 * The fix is a transaction-scoped Postgres advisory lock keyed off the
 * statement id, taken at the top of `reconcileStatement`. Two concurrent
 * calls for the same statement serialize behind the lock; the second
 * caller re-reads the line items inside the lock, sees the snapshot the
 * first caller just committed, and follows the idempotent path.
 *
 * Tests:
 *   1. Two parallel `reconcileStatement(sameStatementId)` calls credit
 *      the agent exactly ONCE (the bug we are closing).
 *   2. Parallel reconciles of DIFFERENT statements still both produce
 *      correct credits, demonstrating the lock is per-statement, not
 *      global.
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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentCommissionPayoutsTable,
  carriersTable,
  commissionLineItemsTable,
  commissionStatementsTable,
  contactsTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  seedContact,
  type TestDb,
} from "../helpers/testDb";

let reconcileStatement: typeof import("../../workers/reconcileCommissionStatement").reconcileStatement;

let org: { id: string };
let carrier: { id: string };

async function seedCarrier(
  db: TestDb,
  opts: { orgId: string; name?: string },
): Promise<{ id: string }> {
  const id = `carrier-${randomUUID()}`;
  await db.insert(carriersTable).values({
    id,
    orgId: opts.orgId,
    name: opts.name ?? "Humana",
    isActive: true,
  });
  return { id };
}

async function insertStatement(
  db: TestDb,
  opts: {
    orgId: string;
    carrierId: string;
    periodStart?: string;
    periodEnd?: string;
  },
): Promise<{ id: string }> {
  const id = `stmt-${randomUUID()}`;
  await db.insert(commissionStatementsTable).values({
    id,
    orgId: opts.orgId,
    carrierId: opts.carrierId,
    statementDate: "2025-02-01",
    periodStart: opts.periodStart ?? "2025-01-01",
    periodEnd: opts.periodEnd ?? "2025-01-31",
    totalAmount: "1000.00",
    currency: "USD",
    source: "csv_upload",
    storageKey: `commission-statements/${opts.orgId}/${id}/file.csv`,
    status: "parsed",
    uploadedByUserId: null,
  });
  return { id };
}

async function insertLineItem(
  db: TestDb,
  opts: {
    statementId: string;
    orgId: string;
    memberId: string;
    commissionAmount: string;
    periodStart: string;
    periodEnd: string;
  },
): Promise<{ id: string }> {
  const id = `li-${randomUUID()}`;
  await db.insert(commissionLineItemsTable).values({
    id,
    statementId: opts.statementId,
    orgId: opts.orgId,
    contactId: null,
    memberId: opts.memberId,
    policyNumber: `POL-${id.slice(-6)}`,
    planType: "MAPD",
    planYear: 2025,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    premium: "120.00",
    commissionAmount: opts.commissionAmount,
    type: "initial",
    writingAgentId: null,
    matchStatus: "unmatched",
    raw: {},
  });
  return { id };
}

beforeAll(async () => {
  const handle = await bootTestDb();
  reconcileStatement = (
    await import("../../workers/reconcileCommissionStatement")
  ).reconcileStatement;

  org = await seedOrg(handle.db, { id: `recon-conc-org-${randomUUID()}` });
  await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
    id: `recon-conc-admin-${randomUUID()}`,
  });
  carrier = await seedCarrier(handle.db, { orgId: org.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("reconcileStatement concurrency", () => {
  it("two concurrent reconciles of the same statement credit the agent exactly once", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const memberId = `MEM-CONC-${randomUUID()}`;
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: memberId,
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const periodStart = "2025-10-01";
    const periodEnd = "2025-10-31";
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    // The line item's memberId is the plaintext MBI; matchContact()
    // hashes it and looks up the contact via the HMAC blind index.
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: contact.medicareId!,
      commissionAmount: "100.00",
      periodStart,
      periodEnd,
    });

    // Fire two reconciles in parallel. Without the per-statement
    // advisory lock, the in-memory `prevContribution=null` is shared
    // across the interleaved awaits and the writing agent gets +100
    // applied twice → earned=200. With the lock, the second caller
    // blocks until the first commits, re-reads the now-populated
    // snapshot, and falls through the idempotent path → earned=100.
    const results = await Promise.all([
      reconcileStatement(stmt.id, org.id),
      reconcileStatement(stmt.id, org.id),
    ]);

    // Both callers must observe a successful reconcile.
    for (const r of results) {
      expect(r.matched).toBe(1);
      expect(r.unmatched).toBe(0);
    }

    const [payout] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(payout).toBeDefined();
    // The critical assertion: earned MUST be exactly 100, not 200.
    expect(Number(payout.earned)).toBeCloseTo(100.0, 2);

    // Exactly one payout row for the agent/period — no duplicates.
    const allPayoutsForAgent = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
        ),
      );
    expect(allPayoutsForAgent.length).toBe(1);
  });

  it("concurrent reconciles of DIFFERENT statements both credit correctly", async () => {
    const handle = await bootTestDb();
    const agentA = await seedAgent(handle.db, { orgId: org.id });
    const agentB = await seedAgent(handle.db, { orgId: org.id });
    const contactA = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: `MEM-CONC-A-${randomUUID()}`,
    });
    const contactB = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: `MEM-CONC-B-${randomUUID()}`,
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: agentA.id })
      .where(eq(contactsTable.id, contactA.id));
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: agentB.id })
      .where(eq(contactsTable.id, contactB.id));

    const periodStart = "2025-11-01";
    const periodEnd = "2025-11-30";

    const stmtA = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    const stmtB = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });

    const memA = contactA.medicareId;
    const memB = contactB.medicareId;

    await insertLineItem(handle.db, {
      statementId: stmtA.id,
      orgId: org.id,
      memberId: memA!,
      commissionAmount: "200.00",
      periodStart,
      periodEnd,
    });
    await insertLineItem(handle.db, {
      statementId: stmtB.id,
      orgId: org.id,
      memberId: memB!,
      commissionAmount: "300.00",
      periodStart,
      periodEnd,
    });

    // Different statements hash to different advisory-lock keys, so
    // these two reconciles do not serialize on the lock — and both must
    // produce correct credits.
    const [rA, rB] = await Promise.all([
      reconcileStatement(stmtA.id, org.id),
      reconcileStatement(stmtB.id, org.id),
    ]);
    expect(rA.matched).toBe(1);
    expect(rB.matched).toBe(1);

    const [payoutA] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, agentA.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    const [payoutB] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, agentB.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(payoutA.earned)).toBeCloseTo(200.0, 2);
    expect(Number(payoutB.earned)).toBeCloseTo(300.0, 2);
  });
});
