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
 *   4. Upserts agent_commission_payouts for the period (earned += split).
 *   5. Marks the line item match_status = matched / unmatched.
 *   6. Sets the parent statement.status = 'reconciled'.
 *   7. Fires `commission_received` automation triggers per matched item
 *      and `chargeback_received` for chargebacks.
 *
 * Returns counts so the inline endpoint can show them to the caller.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentCommissionPayoutsTable,
  commissionHierarchiesTable,
  commissionLineItemsTable,
  commissionStatementsTable,
  contactsTable,
  dealsTable,
} from "@workspace/db";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";

export interface ReconcileResult {
  matched: number;
  unmatched: number;
  payouts: number;
}

export interface ReconcileCommissionStatementJobPayload extends Record<string, unknown> {
  statementId: string;
  orgId: string;
}

interface SplitDistribution {
  agentId: string;
  amount: number; // dollars
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

async function matchContact(
  orgId: string,
  item: { memberId: string | null; raw: unknown },
): Promise<string | null> {
  // Member ID exact match first
  if (item.memberId) {
    const [hit] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, orgId),
          eq(contactsTable.medicareId, item.memberId),
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

async function computeSplits(
  orgId: string,
  writingAgentId: string,
  amount: number,
  on: Date,
): Promise<SplitDistribution[]> {
  // Pull every effective hierarchy row for the writing agent at `on`
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
    // No hierarchy → entire amount to the writing agent
    return [{ agentId: writingAgentId, amount }];
  }

  // Sum split percentages — anything left over stays with the writing agent
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function upsertPayout(
  orgId: string,
  agentId: string,
  periodStart: string,
  periodEnd: string,
  delta: number,
): Promise<void> {
  // Try update first; on no-match, insert.
  const updated = await db
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

  await db
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

    await db
      .update(commissionLineItemsTable)
      .set({
        contactId,
        writingAgentId,
        matchStatus: newMatchStatus,
      })
      .where(eq(commissionLineItemsTable.id, item.id));

    if (newMatchStatus === "matched" || newMatchStatus === "manual") {
      matched++;
    } else {
      unmatched++;
    }

    // Compute splits + upsert payouts when we have an agent
    if (writingAgentId) {
      const amountNum = Number(item.commissionAmount);
      if (Number.isFinite(amountNum) && amountNum !== 0) {
        const splits = await computeSplits(
          orgId,
          writingAgentId,
          amountNum,
          new Date(periodStart),
        );
        for (const s of splits) {
          if (s.amount === 0) continue;
          await upsertPayout(orgId, s.agentId, periodStart, periodEnd, s.amount);
          payoutAgents.add(s.agentId);
        }
      }
    }

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
