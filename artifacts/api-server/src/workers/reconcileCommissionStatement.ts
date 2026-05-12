/**
 * Reconcile Commission Statement worker.
 *
 * Walks every line item on a statement and:
 *   1. Matches member_id → contacts.medicareId; falls back to fuzzy
 *      match on (last name + DOB + state).
 *   2. Resolves the writing agent from the matched contact's
 *      assignedAgentId, or from the earliest deal owner if assigned is
 *      null.
 *   3. Applies effective-dated commission_hierarchies to compute
 *      writing-agent and upline splits.
 *   4. Upserts agent_commission_payouts for the period (earned += delta)
 *      where the delta is `new split - previously contributed split` so
 *      retries / re-runs stay idempotent. Each line item's payout updates
 *      and the contribution-snapshot write happen in a single transaction.
 *   5. Marks the line item match_status = matched / unmatched.
 *   6. Sets the parent statement.status = 'reconciled'.
 *   7. Fires `commission_received` automation triggers per matched item
 *      and `chargeback_received` for chargebacks.
 *
 * Idempotency guarantee: re-invoking `reconcileStatement` for the same
 * statement (operator clicks "reconcile" twice, pg-boss retries on
 * crash/timeout, statement CSV re-uploaded, etc.) will NOT double-credit
 * agents. The `commission_line_items.payout_contribution` JSONB column
 * stores the splits each line item has already contributed; on re-run the
 * worker only applies the per-agent diff between the new and stored
 * snapshots.
 *
 * Returns counts so the inline endpoint can show them to the caller.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentCommissionPayoutsTable,
  commissionLineItemsTable,
  commissionStatementsTable,
  contactsTable,
  dealsTable,
  hashMedicareId,
  isMedicareIdEncryptionReadEnabled,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import {
  computeSplits,
  round2,
  type PayoutContribution,
  type SplitDistribution,
} from "./commissionSplits";

export interface ReconcileResult {
  matched: number;
  unmatched: number;
  payouts: number;
}

export interface ReconcileCommissionStatementJobPayload extends Record<string, unknown> {
  statementId: string;
  orgId: string;
}

/**
 * Anything that exposes the drizzle query builders we use (top-level `db`
 * or a transaction handle from `db.transaction`). We accept the
 * transaction-callback argument type directly so `tx` from
 * `db.transaction(tx => ...)` is assignable.
 */
type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function matchContact(
  orgId: string,
  item: { memberId: string | null; raw: unknown },
): Promise<string | null> {
  // Member ID exact match first. When HIPAA-2 column-level encryption is
  // enabled we compare against the deterministic HMAC hash; otherwise we
  // fall through to the legacy plaintext column.
  if (item.memberId) {
    const memberIdMatch = isMedicareIdEncryptionReadEnabled()
      ? eq(contactsTable.medicareIdHash, hashMedicareId(item.memberId))
      : eq(contactsTable.medicareId, item.memberId);
    const [hit] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, orgId),
          memberIdMatch,
          isNull(contactsTable.deletedAt),
        ),
      )
      .limit(1);
    if (hit) return hit.id;
  }

  // Fuzzy fallback: lastName + DOB + stateCode pulled out of raw payload
  const raw = (item.raw ?? {}) as Record<string, unknown>;
  const lastName = (raw.contactLastName ?? raw.lastName) as string | undefined;
  const dob = (raw.contactDob ?? raw.dob) as string | undefined;
  const stateCode = (raw.contactStateCode ?? raw.stateCode) as string | undefined;

  if (!lastName || !dob) return null;

  const dobDate = new Date(dob);
  if (Number.isNaN(dobDate.getTime())) return null;

  const conditions = [
    eq(contactsTable.orgId, orgId),
    sql`lower(${contactsTable.lastName}) = lower(${lastName})`,
    sql`date(${contactsTable.dob}) = date(${dob})`,
    isNull(contactsTable.deletedAt),
  ];
  if (stateCode) {
    conditions.push(eq(contactsTable.stateCode, stateCode));
  }

  const [hit] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(...conditions))
    .limit(1);

  return hit?.id ?? null;
}

async function resolveWritingAgent(
  orgId: string,
  contactId: string,
): Promise<string | null> {
  const [contact] = await db
    .select({ assignedAgentId: contactsTable.assignedAgentId })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)))
    .limit(1);
  if (contact?.assignedAgentId) return contact.assignedAgentId;

  // Fallback: earliest deal owner on this contact
  const [deal] = await db
    .select({ assignedAgentId: dealsTable.assignedAgentId })
    .from(dealsTable)
    .where(and(eq(dealsTable.contactId, contactId), eq(dealsTable.orgId, orgId)))
    .orderBy(asc(dealsTable.createdAt))
    .limit(1);
  return deal?.assignedAgentId ?? null;
}

/**
 * Build a `{ agentId → delta }` map representing the net change required
 * to move the on-disk earned column from `prev` to `next`. Agents that
 * appear in only one snapshot get their full amount as the delta (with the
 * appropriate sign).
 */
function diffSplits(
  prev: SplitDistribution[] | undefined,
  next: SplitDistribution[],
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const s of next) {
    deltas.set(s.agentId, (deltas.get(s.agentId) ?? 0) + s.amount);
  }
  for (const s of prev ?? []) {
    deltas.set(s.agentId, (deltas.get(s.agentId) ?? 0) - s.amount);
  }
  // Quantize and drop noise from float arithmetic.
  for (const [agentId, raw] of deltas) {
    const v = round2(raw);
    if (v === 0) {
      deltas.delete(agentId);
    } else {
      deltas.set(agentId, v);
    }
  }
  return deltas;
}

/**
 * True when the new splits would produce the same per-agent totals that
 * `prev` already contributed, for the same period. Order-insensitive.
 */
function isSameContribution(
  prev: PayoutContribution | null,
  next: PayoutContribution,
): boolean {
  if (!prev) return false;
  if (
    prev.writingAgentId !== next.writingAgentId ||
    prev.periodStart !== next.periodStart ||
    prev.periodEnd !== next.periodEnd
  ) {
    return false;
  }
  return diffSplits(prev.splits, next.splits).size === 0;
}

async function upsertPayout(
  tx: DbOrTx,
  orgId: string,
  agentId: string,
  periodStart: string,
  periodEnd: string,
  delta: number,
): Promise<void> {
  // Try update first; on no-match, insert.
  const updated = await tx
    .update(agentCommissionPayoutsTable)
    .set({
      earned: sql`${agentCommissionPayoutsTable.earned} + ${delta.toFixed(2)}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentCommissionPayoutsTable.orgId, orgId),
        eq(agentCommissionPayoutsTable.agentId, agentId),
        eq(agentCommissionPayoutsTable.periodStart, periodStart),
        eq(agentCommissionPayoutsTable.periodEnd, periodEnd),
      ),
    )
    .returning({ id: agentCommissionPayoutsTable.id });

  if (updated.length > 0) return;

  await tx
    .insert(agentCommissionPayoutsTable)
    .values({
      id: randomUUID(),
      orgId,
      agentId,
      periodStart,
      periodEnd,
      earned: delta.toFixed(2),
      paid: "0",
      status: "open",
    })
    .onConflictDoUpdate({
      target: [
        agentCommissionPayoutsTable.orgId,
        agentCommissionPayoutsTable.agentId,
        agentCommissionPayoutsTable.periodStart,
        agentCommissionPayoutsTable.periodEnd,
      ],
      set: {
        earned: sql`${agentCommissionPayoutsTable.earned} + ${delta.toFixed(2)}`,
        updatedAt: new Date(),
      },
    });
}

export async function reconcileStatement(
  statementId: string,
  orgId: string,
): Promise<ReconcileResult> {
  const [statement] = await db
    .select()
    .from(commissionStatementsTable)
    .where(
      and(
        eq(commissionStatementsTable.id, statementId),
        eq(commissionStatementsTable.orgId, orgId),
      ),
    )
    .limit(1);

  if (!statement) {
    throw new Error(`Statement ${statementId} not found`);
  }

  const lineItems = await db
    .select()
    .from(commissionLineItemsTable)
    .where(
      and(
        eq(commissionLineItemsTable.statementId, statementId),
        eq(commissionLineItemsTable.orgId, orgId),
      ),
    );

  let matched = 0;
  let unmatched = 0;
  const payoutAgents = new Set<string>();

  for (const item of lineItems) {
    let contactId = item.contactId;
    let writingAgentId = item.writingAgentId;

    if (!contactId) {
      contactId = await matchContact(orgId, {
        memberId: item.memberId,
        raw: item.raw,
      });
    }

    if (contactId && !writingAgentId) {
      writingAgentId = await resolveWritingAgent(orgId, contactId);
    }

    const periodStart =
      (item.periodStart as unknown as string) ??
      (statement.periodStart as unknown as string);
    const periodEnd =
      (item.periodEnd as unknown as string) ??
      (statement.periodEnd as unknown as string);

    const newMatchStatus =
      item.matchStatus === "manual"
        ? "manual"
        : contactId && writingAgentId
          ? "matched"
          : "unmatched";

    if (newMatchStatus === "matched" || newMatchStatus === "manual") {
      matched++;
    } else {
      unmatched++;
    }

    // Compute splits + reconcile payouts when we have an agent.
    //
    // The match-status / contactId / writingAgentId updates and the
    // payout-contribution snapshot write live in the same transaction as
    // the payout upserts, so a crash mid-loop cannot leave the system
    // with payouts credited but no snapshot recorded (which is exactly
    // the failure mode that caused the original double-pay bug).
    let nextContribution: PayoutContribution | null = null;
    const splits: SplitDistribution[] = [];
    if (writingAgentId) {
      const amountNum = Number(item.commissionAmount);
      if (Number.isFinite(amountNum) && amountNum !== 0) {
        const computed = await computeSplits(
          orgId,
          writingAgentId,
          amountNum,
          new Date(periodStart),
        );
        splits.push(...computed);
        nextContribution = {
          writingAgentId,
          periodStart,
          periodEnd,
          splits,
        };
      }
    }

    const prevContribution =
      (item.payoutContribution as PayoutContribution | null) ?? null;

    await db.transaction(async (tx) => {
      await tx
        .update(commissionLineItemsTable)
        .set({
          contactId,
          writingAgentId,
          matchStatus: newMatchStatus,
        })
        .where(eq(commissionLineItemsTable.id, item.id));

      if (!nextContribution) {
        // No (current) payout-relevant state. If we previously credited
        // splits (e.g. writing agent was unassigned between runs), reverse
        // them so totals stay consistent.
        if (prevContribution && prevContribution.splits.length > 0) {
          for (const s of prevContribution.splits) {
            if (s.amount === 0) continue;
            await upsertPayout(
              tx,
              orgId,
              s.agentId,
              prevContribution.periodStart,
              prevContribution.periodEnd,
              -s.amount,
            );
            payoutAgents.add(s.agentId);
          }
          await tx
            .update(commissionLineItemsTable)
            .set({ payoutContribution: null })
            .where(eq(commissionLineItemsTable.id, item.id));
        }
        return;
      }

      if (isSameContribution(prevContribution, nextContribution)) {
        // Idempotent re-run: same agent, same period, same splits.
        // Skip the upsert but still surface each agent in the counter so
        // callers reporting "payouts touched" match the pre-fix behavior.
        for (const s of nextContribution.splits) {
          if (s.amount !== 0) payoutAgents.add(s.agentId);
        }
        return;
      }

      // Either first-ever contribution or splits/period changed. Compute
      // the per-agent delta from prev → next (covers period changes too
      // by reversing the old period and crediting the new one).
      const samePeriod =
        prevContribution &&
        prevContribution.periodStart === nextContribution.periodStart &&
        prevContribution.periodEnd === nextContribution.periodEnd;

      if (prevContribution && !samePeriod) {
        for (const s of prevContribution.splits) {
          if (s.amount === 0) continue;
          await upsertPayout(
            tx,
            orgId,
            s.agentId,
            prevContribution.periodStart,
            prevContribution.periodEnd,
            -s.amount,
          );
          payoutAgents.add(s.agentId);
        }
        for (const s of nextContribution.splits) {
          if (s.amount === 0) continue;
          await upsertPayout(
            tx,
            orgId,
            s.agentId,
            nextContribution.periodStart,
            nextContribution.periodEnd,
            s.amount,
          );
          payoutAgents.add(s.agentId);
        }
      } else {
        const deltas = diffSplits(prevContribution?.splits, nextContribution.splits);
        for (const [agentId, delta] of deltas) {
          await upsertPayout(
            tx,
            orgId,
            agentId,
            nextContribution.periodStart,
            nextContribution.periodEnd,
            delta,
          );
          payoutAgents.add(agentId);
        }
        // Even if the delta map was empty for some agent (i.e. their
        // amount didn't change), still report them as "touched" so the
        // reconcile summary remains a count of agents with active splits.
        for (const s of nextContribution.splits) {
          if (s.amount !== 0) payoutAgents.add(s.agentId);
        }
      }

      await tx
        .update(commissionLineItemsTable)
        .set({ payoutContribution: nextContribution })
        .where(eq(commissionLineItemsTable.id, item.id));
    });

    // Fire automation triggers
    if (newMatchStatus === "matched" || newMatchStatus === "manual") {
      if (item.type === "chargeback") {
        await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
          orgId,
          trigger: "chargeback_received",
          resourceType: "commission_line_item",
          resourceId: item.id,
          context: {
            contactId,
            writingAgentId,
            commissionAmount: item.commissionAmount,
            policyNumber: item.policyNumber,
          },
        });
      } else {
        await enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
          orgId,
          trigger: "commission_received",
          resourceType: "commission_line_item",
          resourceId: item.id,
          context: {
            contactId,
            writingAgentId,
            commissionAmount: item.commissionAmount,
            type: item.type,
            policyNumber: item.policyNumber,
          },
        });
      }
    }
  }

  await db
    .update(commissionStatementsTable)
    .set({ status: "reconciled" })
    .where(eq(commissionStatementsTable.id, statementId));

  logger.info(
    { statementId, matched, unmatched, payouts: payoutAgents.size },
    "Reconciled commission statement",
  );

  return { matched, unmatched, payouts: payoutAgents.size };
}

/**
 * pg-boss worker entrypoint.
 */
export async function reconcileCommissionStatementWorker(
  payload: ReconcileCommissionStatementJobPayload,
): Promise<void> {
  try {
    await reconcileStatement(payload.statementId, payload.orgId);
  } catch (err) {
    logger.error({ err, payload }, "Reconciliation worker failed");
    throw err;
  }
}
