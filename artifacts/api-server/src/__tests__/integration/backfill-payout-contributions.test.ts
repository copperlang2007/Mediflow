/**
 * Backfill: `commission_line_items.payout_contribution` snapshots.
 *
 * The reconcile worker started writing this JSONB snapshot in PR #66.
 * Rows that were reconciled BEFORE that PR have payout_contribution NULL
 * but their splits are already credited in `agent_commission_payouts`.
 * Without a snapshot, a re-reconcile blindly re-credits — i.e. agents
 * get paid twice. The backfill script writes the snapshot the worker
 * would have written, WITHOUT touching the payouts table.
 *
 * The most important property tested here:
 *   After backfill, running `reconcileStatement` again on the same
 *   statement does NOT change `agent_commission_payouts.earned`. That
 *   proves the snapshot we wrote is consistent with the credits
 *   already on disk.
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
let backfillPayoutContributions: typeof import("@workspace/scripts/backfill-payout-contributions").backfillPayoutContributions;

let org: { id: string };
let carrier: { id: string };

async function seedCarrier(
  db: TestDb,
  opts: { orgId: string },
): Promise<{ id: string }> {
  const id = `carrier-${randomUUID()}`;
  await db.insert(carriersTable).values({
    id,
    orgId: opts.orgId,
    name: "Aetna",
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
): Promise<{ id: string; periodStart: string; periodEnd: string }> {
  const id = `stmt-${randomUUID()}`;
  const periodStart = opts.periodStart ?? "2025-01-01";
  const periodEnd = opts.periodEnd ?? "2025-01-31";
  await db.insert(commissionStatementsTable).values({
    id,
    orgId: opts.orgId,
    carrierId: opts.carrierId,
    statementDate: "2025-02-01",
    periodStart,
    periodEnd,
    totalAmount: "1000.00",
    currency: "USD",
    source: "csv_upload",
    storageKey: `commission-statements/${opts.orgId}/${id}/file.csv`,
    status: "reconciled",
    uploadedByUserId: null,
  });
  return { id, periodStart, periodEnd };
}

interface InsertLineItemOpts {
  statementId: string;
  orgId: string;
  contactId?: string | null;
  writingAgentId?: string | null;
  matchStatus?: "matched" | "manual" | "unmatched";
  commissionAmount?: string;
  periodStart?: string;
  periodEnd?: string;
  payoutContribution?: unknown;
}

async function insertLineItem(
  db: TestDb,
  opts: InsertLineItemOpts,
): Promise<{ id: string }> {
  const id = `li-${randomUUID()}`;
  await db.insert(commissionLineItemsTable).values({
    id,
    statementId: opts.statementId,
    orgId: opts.orgId,
    contactId: opts.contactId ?? null,
    memberId: null,
    policyNumber: `POL-${id.slice(-6)}`,
    planType: "MAPD",
    planYear: 2025,
    periodStart: opts.periodStart ?? "2025-01-01",
    periodEnd: opts.periodEnd ?? "2025-01-31",
    premium: "120.00",
    commissionAmount: opts.commissionAmount ?? "100.00",
    type: "initial",
    writingAgentId: opts.writingAgentId ?? null,
    matchStatus: opts.matchStatus ?? "matched",
    raw: {},
    payoutContribution:
      (opts.payoutContribution as never) ?? (null as never),
  });
  return { id };
}

beforeAll(async () => {
  const handle = await bootTestDb();
  reconcileStatement = (
    await import("../../workers/reconcileCommissionStatement")
  ).reconcileStatement;
  backfillPayoutContributions = (
    await import("@workspace/scripts/backfill-payout-contributions")
  ).backfillPayoutContributions;

  org = await seedOrg(handle.db, { id: `bf-org-${randomUUID()}` });
  await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
    id: `bf-admin-${randomUUID()}`,
  });
  carrier = await seedCarrier(handle.db, { orgId: org.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("backfill payout_contribution", () => {
  it("writes a snapshot for an eligible NULL-snapshot line item", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, { orgId: org.id });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2024-10-01",
      periodEnd: "2024-10-31",
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      contactId: contact.id,
      writingAgentId: writing.id,
      matchStatus: "matched",
      commissionAmount: "100.00",
      periodStart: "2024-10-01",
      periodEnd: "2024-10-31",
      payoutContribution: null,
    });

    const stats = await backfillPayoutContributions({ dryRun: false });
    expect(stats.backfilled).toBeGreaterThanOrEqual(1);

    const [row] = await handle.db
      .select({ payoutContribution: commissionLineItemsTable.payoutContribution })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, li.id))
      .limit(1);

    expect(row.payoutContribution).toBeTruthy();
    const snap = row.payoutContribution as {
      writingAgentId: string;
      periodStart: string;
      periodEnd: string;
      splits: { agentId: string; amount: number }[];
    };
    expect(snap.writingAgentId).toBe(writing.id);
    expect(snap.periodStart).toBe("2024-10-01");
    expect(snap.periodEnd).toBe("2024-10-31");
    expect(snap.splits).toHaveLength(1);
    expect(snap.splits[0].agentId).toBe(writing.id);
    expect(snap.splits[0].amount).toBeCloseTo(100.0, 2);
  });

  it("leaves rows with an existing snapshot untouched", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2024-11-01",
      periodEnd: "2024-11-30",
    });

    const sentinel = {
      writingAgentId: writing.id,
      periodStart: "2024-11-01",
      periodEnd: "2024-11-30",
      splits: [{ agentId: writing.id, amount: 42.0 }],
    };

    // Snapshotted row.
    const snapshotted = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      writingAgentId: writing.id,
      matchStatus: "matched",
      commissionAmount: "100.00",
      periodStart: "2024-11-01",
      periodEnd: "2024-11-30",
      payoutContribution: sentinel,
    });

    // Also insert a NULL-snapshot row in the same statement so the
    // statement-narrowing query in the script reaches this statement
    // and the snapshotted row falls through the per-line-item
    // "already snapshotted" branch.
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      writingAgentId: writing.id,
      matchStatus: "matched",
      commissionAmount: "50.00",
      periodStart: "2024-11-01",
      periodEnd: "2024-11-30",
      payoutContribution: null,
    });

    const before = await backfillPayoutContributions({ dryRun: false });
    // Second run: now both rows are snapshotted, so the statement is
    // filtered out entirely.
    const after = await backfillPayoutContributions({ dryRun: false });

    const [row] = await handle.db
      .select({ payoutContribution: commissionLineItemsTable.payoutContribution })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, snapshotted.id))
      .limit(1);
    expect(row.payoutContribution).toEqual(sentinel);

    // The pre-existing snapshot was examined and skipped on the first
    // pass. On the second pass the statement is filtered out entirely,
    // so the counter goes back to zero — both are valid outcomes for
    // "did not write to this row".
    expect(before.skippedAlreadySnapshotted).toBeGreaterThanOrEqual(1);
    expect(after.skippedAlreadySnapshotted).toBe(0);
  });

  it("leaves unmatched rows untouched (no snapshot written)", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2024-12-01",
      periodEnd: "2024-12-31",
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      writingAgentId: writing.id,
      matchStatus: "unmatched", // ← ineligible
      commissionAmount: "100.00",
      periodStart: "2024-12-01",
      periodEnd: "2024-12-31",
      payoutContribution: null,
    });

    await backfillPayoutContributions({ dryRun: false });

    const [row] = await handle.db
      .select({ payoutContribution: commissionLineItemsTable.payoutContribution })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, li.id))
      .limit(1);
    expect(row.payoutContribution).toBeNull();
  });

  it("leaves matched rows without a writing agent untouched", async () => {
    const handle = await bootTestDb();
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      writingAgentId: null, // ← ineligible
      matchStatus: "matched",
      commissionAmount: "100.00",
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      payoutContribution: null,
    });

    await backfillPayoutContributions({ dryRun: false });

    const [row] = await handle.db
      .select({ payoutContribution: commissionLineItemsTable.payoutContribution })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, li.id))
      .limit(1);
    expect(row.payoutContribution).toBeNull();
  });

  it("dry-run mode reports counts but writes nothing", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2025-03-01",
      periodEnd: "2025-03-31",
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      writingAgentId: writing.id,
      matchStatus: "matched",
      commissionAmount: "75.00",
      periodStart: "2025-03-01",
      periodEnd: "2025-03-31",
      payoutContribution: null,
    });

    const stats = await backfillPayoutContributions({ dryRun: true });
    expect(stats.backfilled).toBeGreaterThanOrEqual(1);

    const [row] = await handle.db
      .select({ payoutContribution: commissionLineItemsTable.payoutContribution })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, li.id))
      .limit(1);
    // No write happened — snapshot is still NULL.
    expect(row.payoutContribution).toBeNull();
  });

  it("CRITICAL: after backfill a re-reconcile does NOT change earned (no double-credit)", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const upline = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: `MEM-BF-${randomUUID()}`,
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    // Hierarchy: 30% upline, 70% writing.
    await handle.db.insert(commissionHierarchiesTable).values({
      id: `hier-${randomUUID()}`,
      orgId: org.id,
      writingAgentId: writing.id,
      uplineAgentId: upline.id,
      splitPct: "30",
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
    });

    const periodStart = "2025-04-01";
    const periodEnd = "2025-04-30";
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart,
      periodEnd,
    });
    const memberId = contact.medicareId!;

    // Simulate a "legacy" line item: matched, has writing agent, payouts
    // already credited, but payout_contribution IS NULL because it was
    // reconciled before PR #66.
    const lineItemId = `li-legacy-${randomUUID()}`;
    await handle.db.insert(commissionLineItemsTable).values({
      id: lineItemId,
      statementId: stmt.id,
      orgId: org.id,
      contactId: contact.id,
      memberId,
      policyNumber: "POL-LEGACY",
      planType: "MAPD",
      planYear: 2025,
      periodStart,
      periodEnd,
      premium: "120.00",
      commissionAmount: "200.00",
      type: "initial",
      writingAgentId: writing.id,
      matchStatus: "matched",
      raw: {},
      payoutContribution: null,
    });

    // Seed the payouts as if the original (pre-PR-#66) reconcile already
    // credited them: writing gets $140, upline gets $60.
    await handle.db.insert(agentCommissionPayoutsTable).values([
      {
        id: `payout-${randomUUID()}`,
        orgId: org.id,
        agentId: writing.id,
        periodStart,
        periodEnd,
        earned: "140.00",
        paid: "0",
        status: "open",
      },
      {
        id: `payout-${randomUUID()}`,
        orgId: org.id,
        agentId: upline.id,
        periodStart,
        periodEnd,
        earned: "60.00",
        paid: "0",
        status: "open",
      },
    ]);

    // Run the backfill.
    const stats = await backfillPayoutContributions({ dryRun: false });
    expect(stats.backfilled).toBeGreaterThanOrEqual(1);
    // No mismatches expected — hierarchy hasn't changed since the
    // "original" reconcile in this test.
    expect(stats.skippedSplitMismatch).toBe(0);

    // Capture earned totals BEFORE the second reconcile.
    const earnedBefore = await handle.db
      .select({
        agentId: agentCommissionPayoutsTable.agentId,
        earned: agentCommissionPayoutsTable.earned,
      })
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );

    // Now re-reconcile the statement. With the snapshot in place this
    // MUST be a no-op as far as earned goes.
    await reconcileStatement(stmt.id, org.id);

    const earnedAfter = await handle.db
      .select({
        agentId: agentCommissionPayoutsTable.agentId,
        earned: agentCommissionPayoutsTable.earned,
      })
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.periodStart, periodStart),
        ),
      );

    const byAgent = (
      rows: { agentId: string; earned: string }[],
    ): Record<string, number> =>
      Object.fromEntries(rows.map((r) => [r.agentId, Number(r.earned)]));

    const before = byAgent(earnedBefore);
    const after = byAgent(earnedAfter);
    expect(after[writing.id]).toBeCloseTo(before[writing.id], 2);
    expect(after[upline.id]).toBeCloseTo(before[upline.id], 2);
    // Specifically, no double-credit happened:
    expect(after[writing.id]).toBeCloseTo(140.0, 2);
    expect(after[upline.id]).toBeCloseTo(60.0, 2);
  });
});
