/**
 * One-shot backfill for `commission_line_items.payout_contribution`.
 *
 * PR #66 added `payout_contribution jsonb` to record the per-agent split
 * each line item has already contributed to `agent_commission_payouts`,
 * and rewrote `reconcileStatement` to apply only the diff between the new
 * splits and the snapshot on subsequent runs.
 *
 * Line items reconciled BEFORE PR #66 landed have `payout_contribution
 * IS NULL` but their splits are already credited in
 * `agent_commission_payouts.earned`. If an operator re-reconciles such a
 * statement, the worker sees no snapshot, treats the line item as a fresh
 * credit, and the agent gets paid twice. This script writes the missing
 * snapshot so re-reconciles become no-ops on legacy data.
 *
 * Rules:
 *   - Only touches rows where:
 *       payout_contribution IS NULL
 *       AND match_status IN ('matched','manual')
 *       AND writing_agent_id IS NOT NULL
 *   - Recomputes splits the same way `reconcileStatement` does (same
 *     `computeSplits` import — there is exactly one definition).
 *   - Detects + warns + skips when the recomputed splits don't sum to
 *     the line item's commission_amount (within rounding). This happens
 *     when the hierarchy / override config changed between the original
 *     reconcile and now; we can't recover the historical split from
 *     the DB so an operator must resolve it by hand.
 *   - Does NOT modify `agent_commission_payouts` — the credits are
 *     already on disk; this script just records what they were.
 *   - Idempotent: re-running skips rows that already have a snapshot.
 *   - Cursor-paginated by id (not LIMIT/OFFSET) so a multi-million-row
 *     table doesn't grind.
 *   - Per-line-item transaction — a partial run resumes cleanly.
 *
 * Run:
 *   pnpm --filter @workspace/scripts run backfill:payout-contributions
 *   pnpm --filter @workspace/scripts run backfill:payout-contributions -- --dry-run
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  db,
  commissionLineItemsTable,
  commissionStatementsTable,
  organizationsTable,
  pool,
} from "@workspace/db";
import {
  computeSplits,
  round2,
  type PayoutContribution,
} from "@workspace/api-server/workers/commissionSplits";

interface BackfillStats {
  examined: number;
  backfilled: number;
  skippedAlreadySnapshotted: number;
  skippedNotEligible: number;
  skippedSplitMismatch: number;
}

interface BackfillOptions {
  dryRun: boolean;
}

const BATCH = 200;

/**
 * Sum the per-agent amounts and compare to the recorded commission amount.
 * `computeSplits` builds splits as `amount * (pct/100)` rounded to 2 dp;
 * with a 20/80 split on a $100 line item the sum is exactly 100.00, but
 * uneven percents (e.g. 33.33%) lose a cent to rounding. Tolerate 1 cent
 * per split so we don't false-positive a mismatch on those.
 */
function splitsMatchAmount(
  splits: { amount: number }[],
  amount: number,
): boolean {
  const sum = round2(splits.reduce((acc, s) => acc + s.amount, 0));
  const tolerance = Math.max(0.01, splits.length * 0.01);
  return Math.abs(sum - amount) <= tolerance;
}

async function backfillStatement(
  orgId: string,
  statementId: string,
  opts: BackfillOptions,
  stats: BackfillStats,
): Promise<void> {
  const items = await db
    .select({
      id: commissionLineItemsTable.id,
      orgId: commissionLineItemsTable.orgId,
      statementId: commissionLineItemsTable.statementId,
      writingAgentId: commissionLineItemsTable.writingAgentId,
      matchStatus: commissionLineItemsTable.matchStatus,
      commissionAmount: commissionLineItemsTable.commissionAmount,
      periodStart: commissionLineItemsTable.periodStart,
      periodEnd: commissionLineItemsTable.periodEnd,
      payoutContribution: commissionLineItemsTable.payoutContribution,
    })
    .from(commissionLineItemsTable)
    .where(
      and(
        eq(commissionLineItemsTable.orgId, orgId),
        eq(commissionLineItemsTable.statementId, statementId),
      ),
    );

  // Statement-level period fallback for line items that don't carry their
  // own period (legacy data).
  const stmtPeriod =
    items.length > 0
      ? await db
          .select({
            periodStart: commissionStatementsTable.periodStart,
            periodEnd: commissionStatementsTable.periodEnd,
          })
          .from(commissionStatementsTable)
          .where(eq(commissionStatementsTable.id, statementId))
          .limit(1)
      : [];
  const fallbackStart = stmtPeriod[0]?.periodStart as unknown as
    | string
    | undefined;
  const fallbackEnd = stmtPeriod[0]?.periodEnd as unknown as
    | string
    | undefined;

  for (const item of items) {
    stats.examined += 1;

    if (item.payoutContribution !== null) {
      stats.skippedAlreadySnapshotted += 1;
      continue;
    }

    const eligible =
      (item.matchStatus === "matched" || item.matchStatus === "manual") &&
      item.writingAgentId !== null;
    if (!eligible) {
      stats.skippedNotEligible += 1;
      continue;
    }

    const writingAgentId = item.writingAgentId!;
    const periodStart =
      (item.periodStart as unknown as string) ?? fallbackStart;
    const periodEnd = (item.periodEnd as unknown as string) ?? fallbackEnd;
    if (!periodStart || !periodEnd) {
      stats.skippedNotEligible += 1;
      console.warn(
        `[backfill] line-item ${item.id} (statement ${statementId}) has no period — skipped.`,
      );
      continue;
    }

    const amountNum = Number(item.commissionAmount);
    if (!Number.isFinite(amountNum) || amountNum === 0) {
      // A zero/empty commission produces no splits → nothing to snapshot.
      stats.skippedNotEligible += 1;
      continue;
    }

    const splits = await computeSplits(
      db,
      orgId,
      writingAgentId,
      amountNum,
      new Date(periodStart),
    );

    if (!splitsMatchAmount(splits, amountNum)) {
      stats.skippedSplitMismatch += 1;
      console.warn(
        `[backfill] split-mismatch: statement=${statementId} line_item=${item.id} ` +
          `amount=${amountNum.toFixed(2)} computed_sum=${round2(
            splits.reduce((a, s) => a + s.amount, 0),
          ).toFixed(2)} — hierarchy likely changed since original reconcile; ` +
          `SKIPPED. Operator must resolve manually.`,
      );
      continue;
    }

    const snapshot: PayoutContribution = {
      writingAgentId,
      periodStart,
      periodEnd,
      splits,
    };

    if (opts.dryRun) {
      stats.backfilled += 1;
      console.log(
        `[backfill] (dry-run) would write snapshot for line-item ${item.id}: ${JSON.stringify(
          snapshot,
        )}`,
      );
      continue;
    }

    // One tiny transaction per line item. We could batch by statement, but
    // a single transaction across the whole statement risks a long-held
    // lock if the statement has thousands of items.
    await db.transaction(async (tx) => {
      await tx
        .update(commissionLineItemsTable)
        .set({ payoutContribution: snapshot })
        .where(
          and(
            eq(commissionLineItemsTable.id, item.id),
            // Defensive: don't clobber a snapshot that landed between our
            // SELECT and this UPDATE (e.g. operator re-reconciled while
            // this script was running).
            isNull(commissionLineItemsTable.payoutContribution),
          ),
        );
    });
    stats.backfilled += 1;
  }
}

export async function backfillPayoutContributions(
  opts: BackfillOptions = { dryRun: false },
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    examined: 0,
    backfilled: 0,
    skippedAlreadySnapshotted: 0,
    skippedNotEligible: 0,
    skippedSplitMismatch: 0,
  };

  // Cursor-paginate orgs by id.
  let orgCursor: string | null = null;
  while (true) {
    const orgRows: { id: string }[] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(
        orgCursor === null ? undefined : gt(organizationsTable.id, orgCursor),
      )
      .orderBy(asc(organizationsTable.id))
      .limit(BATCH);

    if (orgRows.length === 0) break;

    for (const org of orgRows) {
      // Cursor-paginate statements within this org. Pulling statement ids
      // (not full rows) keeps memory bounded.
      let stmtCursor: string | null = null;
      while (true) {
        // Narrow to statements that actually contain eligible line items
        // so we don't iterate every statement in the org just to find
        // out it's fully snapshotted already.
        const stmtRows = await db
          .selectDistinct({ id: commissionStatementsTable.id })
          .from(commissionStatementsTable)
          .innerJoin(
            commissionLineItemsTable,
            eq(commissionLineItemsTable.statementId, commissionStatementsTable.id),
          )
          .where(
            and(
              eq(commissionStatementsTable.orgId, org.id),
              isNull(commissionLineItemsTable.payoutContribution),
              isNotNull(commissionLineItemsTable.writingAgentId),
              inArray(commissionLineItemsTable.matchStatus, ["matched", "manual"]),
              stmtCursor === null
                ? undefined
                : gt(commissionStatementsTable.id, stmtCursor),
            ),
          )
          .orderBy(asc(commissionStatementsTable.id))
          .limit(BATCH);

        if (stmtRows.length === 0) break;

        for (const stmt of stmtRows) {
          await backfillStatement(org.id, stmt.id, opts, stats);
        }

        stmtCursor = stmtRows[stmtRows.length - 1].id;
      }
    }

    orgCursor = orgRows[orgRows.length - 1].id;
  }

  return stats;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const start = Date.now();
  console.log(
    `[backfill] starting payout-contribution backfill${dryRun ? " (DRY RUN)" : ""}...`,
  );

  const stats = await backfillPayoutContributions({ dryRun });

  const elapsedMs = Date.now() - start;
  console.log(
    `[backfill] done in ${elapsedMs}ms — ${JSON.stringify(stats, null, 2)}`,
  );

  // Sanity check: how many rows still need a snapshot? Should be the sum of
  // (skippedSplitMismatch + skippedNotEligible) on a non-dry run, or
  // everything-that-was-eligible on a dry run.
  const [remaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(commissionLineItemsTable)
    .where(
      and(
        isNull(commissionLineItemsTable.payoutContribution),
        isNotNull(commissionLineItemsTable.writingAgentId),
        inArray(commissionLineItemsTable.matchStatus, ["matched", "manual"]),
      ),
    );
  console.log(
    `[backfill] remaining eligible-but-unsnapshotted rows: ${remaining?.count ?? 0}`,
  );

  await pool.end();
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("backfill-payout-contributions.ts");

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
}
