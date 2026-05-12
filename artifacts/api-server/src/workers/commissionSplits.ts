/**
 * Pure split-computation primitives extracted from `reconcileStatement`.
 *
 * The reconciliation worker computes per-agent splits for each commission
 * line item, applying effective-dated `commission_hierarchies` rows. The
 * same computation is required by the one-time
 * `backfill-payout-contributions` script (which writes the snapshot
 * `commission_line_items.payout_contribution` JSONB for rows reconciled
 * before the snapshot column was introduced).
 *
 * Keeping this in a separate module lets the backfill script import
 * `computeSplits` without dragging in the pg-boss / queue machinery the
 * reconcile worker depends on.
 *
 * IMPORTANT: do not change the rules here without also reading
 * `reconcileCommissionStatement.ts` — the two MUST stay byte-equivalent
 * (literally the same function call) so a re-reconcile of a back-filled
 * statement is a no-op.
 */

import { and, eq } from "drizzle-orm";
import { db, commissionHierarchiesTable } from "@workspace/db";

export interface SplitDistribution {
  agentId: string;
  amount: number; // dollars
}

export interface PayoutContribution {
  writingAgentId: string;
  periodStart: string;
  periodEnd: string;
  splits: SplitDistribution[];
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isWithin(
  effectiveFrom: string | Date,
  effectiveTo: string | Date | null,
  on: Date,
): boolean {
  const from = new Date(effectiveFrom);
  if (on < dateOnly(from)) return false;
  if (effectiveTo) {
    const to = new Date(effectiveTo);
    if (on > dateOnly(to)) return false;
  }
  return true;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the per-agent split distribution for a single line item.
 *
 * - No hierarchy rows in effect on `on` → 100% to the writing agent.
 * - One or more effective rows → each upline gets `amount * (pct/100)`;
 *   the writing agent keeps `amount * ((100 - sumPct)/100)`. If sumPct is
 *   100 the writing agent's row is dropped because its amount rounds to
 *   zero.
 */
export async function computeSplits(
  orgId: string,
  writingAgentId: string,
  amount: number,
  on: Date,
): Promise<SplitDistribution[]> {
  const rows = await db
    .select()
    .from(commissionHierarchiesTable)
    .where(
      and(
        eq(commissionHierarchiesTable.orgId, orgId),
        eq(commissionHierarchiesTable.writingAgentId, writingAgentId),
      ),
    );

  const effective = rows.filter((r) =>
    isWithin(r.effectiveFrom, r.effectiveTo, on),
  );

  if (effective.length === 0) {
    return [{ agentId: writingAgentId, amount }];
  }

  let allocatedPct = 0;
  const splits: SplitDistribution[] = [];
  for (const r of effective) {
    const pct = Number(r.splitPct);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    allocatedPct += pct;
    if (r.uplineAgentId) {
      splits.push({
        agentId: r.uplineAgentId,
        amount: round2(amount * (pct / 100)),
      });
    }
  }

  const writingPct = Math.max(0, 100 - allocatedPct);
  splits.push({
    agentId: writingAgentId,
    amount: round2(amount * (writingPct / 100)),
  });

  return splits.filter((s) => s.amount !== 0);
}
