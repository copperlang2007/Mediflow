/**
 * Idempotency guarantees for the commission reconciliation worker.
 *
 * The original implementation re-applied every line item's split to
 * `agent_commission_payouts.earned` on every invocation, so any retry
 * (operator double-click, pg-boss crash recovery, CSV re-upload) would
 * double-pay agents. We snapshot each line item's contribution into
 * `commission_line_items.payout_contribution` and only apply the
 * per-agent delta on subsequent runs.
 *
 * The cases below exercise the four behaviors the snapshot must support:
 *
 *   1. Plain re-run: payouts unchanged on the second call.
 *   2. Operator manually assigns a contact between runs: agent is
 *      credited exactly once on the second call.
 *   3. Hierarchy split changes between runs: only the diff is applied.
 *   4. Chargebacks (negative amounts) still reverse credits idempotently.
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
  commissionHierarchiesTable,
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
): Promise<{ id: string; name: string }> {
  const id = `carrier-${randomUUID()}`;
  const name = opts.name ?? "Humana";
  await db.insert(carriersTable).values({
    id,
    orgId: opts.orgId,
    name,
    isActive: true,
  });
  return { id, name };
}

async function insertStatement(
  db: TestDb,
  opts: {
    orgId: string;
    carrierId: string;
    status?: string;
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
    status: opts.status ?? "parsed",
    uploadedByUserId: null,
  });
  return { id };
}

async function insertLineItem(
  db: TestDb,
  opts: {
    statementId: string;
    orgId: string;
    memberId?: string | null;
    commissionAmount: string;
    type?: "initial" | "renewal" | "bonus" | "chargeback";
    periodStart?: string;
    periodEnd?: string;
    contactId?: string | null;
    writingAgentId?: string | null;
  },
): Promise<{ id: string }> {
  const id = `li-${randomUUID()}`;
  await db.insert(commissionLineItemsTable).values({
    id,
    statementId: opts.statementId,
    orgId: opts.orgId,
    contactId: opts.contactId ?? null,
    memberId: opts.memberId ?? null,
    policyNumber: `POL-${id.slice(-6)}`,
    planType: "MAPD",
    planYear: 2025,
    periodStart: opts.periodStart ?? "2025-01-01",
    periodEnd: opts.periodEnd ?? "2025-01-31",
    premium: "120.00",
    commissionAmount: opts.commissionAmount,
    type: opts.type ?? "initial",
    writingAgentId: opts.writingAgentId ?? null,
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

  org = await seedOrg(handle.db, { id: `recon-org-${randomUUID()}` });
  await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
    id: `recon-admin-${randomUUID()}`,
  });
  carrier = await seedCarrier(handle.db, { orgId: org.id, name: "Humana" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("reconcileStatement idempotency", () => {
  it("running reconcile twice does not double-credit the agent", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: `MEM-IDEMP-${randomUUID()}`,
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const periodStart = "2025-06-01";
    const periodEnd = "2025-06-30";
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: contact.medicareId!,
      commissionAmount: "100.00",
      periodStart,
      periodEnd,
    });

    await reconcileStatement(stmt.id, org.id);
    const [firstPayout] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(firstPayout.earned)).toBeCloseTo(100.0, 2);

    // Second call: same data, no changes. Earned MUST NOT double.
    const second = await reconcileStatement(stmt.id, org.id);
    expect(second.matched).toBe(1);

    const [secondPayout] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(secondPayout.earned)).toBeCloseTo(100.0, 2);

    // A third run should be just as safe.
    await reconcileStatement(stmt.id, org.id);
    const [thirdPayout] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(thirdPayout.earned)).toBeCloseTo(100.0, 2);
  });

  it("manually assigning the contact between runs credits the agent exactly once", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    // Note: no member_id on the line item and no contact match yet.
    const periodStart = "2025-07-01";
    const periodEnd = "2025-07-31";
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: "MEM-DOES-NOT-EXIST-YET",
      commissionAmount: "150.00",
      periodStart,
      periodEnd,
    });

    // First run: unmatched, no payout written.
    const first = await reconcileStatement(stmt.id, org.id);
    expect(first.matched).toBe(0);
    expect(first.unmatched).toBe(1);

    const payoutsAfterFirst = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(payoutsAfterFirst.length).toBe(0);

    // Operator manually wires up the contact + writing agent.
    const contact = await seedContact(handle.db, { orgId: org.id });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));
    await handle.db
      .update(commissionLineItemsTable)
      .set({ contactId: contact.id, writingAgentId: writing.id })
      .where(eq(commissionLineItemsTable.id, li.id));

    // Second run: should now credit the agent exactly once.
    const second = await reconcileStatement(stmt.id, org.id);
    expect(second.matched).toBe(1);

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
    expect(Number(payout.earned)).toBeCloseTo(150.0, 2);

    // Third run still must not double.
    await reconcileStatement(stmt.id, org.id);
    const [payoutAgain] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(payoutAgain.earned)).toBeCloseTo(150.0, 2);
  });

  it("changing the upline split between runs applies only the delta", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const upline = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: `MEM-SPLITDELTA-${randomUUID()}`,
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const hierarchyId = `hier-${randomUUID()}`;
    await handle.db.insert(commissionHierarchiesTable).values({
      id: hierarchyId,
      orgId: org.id,
      writingAgentId: writing.id,
      uplineAgentId: upline.id,
      splitPct: "20",
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
    });

    const periodStart = "2025-08-01";
    const periodEnd = "2025-08-31";
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: contact.medicareId!,
      commissionAmount: "200.00",
      periodStart,
      periodEnd,
    });

    // First run: writing 80%, upline 20% → 160 / 40.
    await reconcileStatement(stmt.id, org.id);
    const [w1] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    const [u1] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, upline.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(w1.earned)).toBeCloseTo(160.0, 2);
    expect(Number(u1.earned)).toBeCloseTo(40.0, 2);

    // Operator bumps the upline split from 20 → 50. (Same effective_from,
    // so the prior split is logically replaced.) Writing 50 / upline 50
    // → 100 / 100 from a 200 amount.
    await handle.db
      .update(commissionHierarchiesTable)
      .set({ splitPct: "50" })
      .where(eq(commissionHierarchiesTable.id, hierarchyId));

    await reconcileStatement(stmt.id, org.id);

    const [w2] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    const [u2] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, upline.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    // Totals must reflect the NEW split, not the old + new (double).
    expect(Number(w2.earned)).toBeCloseTo(100.0, 2);
    expect(Number(u2.earned)).toBeCloseTo(100.0, 2);
  });

  it("chargeback line items reverse credits idempotently", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: `MEM-CB-IDEMP-${randomUUID()}`,
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const periodStart = "2025-09-01";
    const periodEnd = "2025-09-30";
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    const memberId = contact.medicareId!;
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId,
      commissionAmount: "-75.00",
      type: "chargeback",
      periodStart,
      periodEnd,
    });

    await reconcileStatement(stmt.id, org.id);
    const [p1] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(p1.earned)).toBeCloseTo(-75.0, 2);

    // Re-run: chargeback must NOT debit a second time.
    await reconcileStatement(stmt.id, org.id);
    const [p2] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );
    expect(Number(p2.earned)).toBeCloseTo(-75.0, 2);
  });
});
