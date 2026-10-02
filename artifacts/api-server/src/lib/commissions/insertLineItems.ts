/**
 * Parse a carrier statement file and store its line items.
 *
 * Shared by the manual upload route (`POST /commissions/statements/:id/parse`)
 * and the automatic folder ingest, so both produce identical rows.
 */
import { randomUUID } from "crypto";
import { db, commissionLineItemsTable } from "@workspace/db";
import type { NormalizedLineItem } from "../commissionParsers";

/** Keeps the bound-parameter count per INSERT manageable. */
const CHUNK_SIZE = 200;

type DbOrTx = Pick<typeof db, "insert">;

/** Map parser output to `commission_line_items` rows (unmatched; reconcile matches them). */
export function toLineItemRows(statementId: string, orgId: string, normalized: NormalizedLineItem[]) {
  return normalized.map((n) => ({
    id: randomUUID(),
    statementId,
    orgId,
    contactId: null,
    memberId: n.memberId,
    policyNumber: n.policyNumber,
    planType: n.planType,
    planYear: n.planYear,
    periodStart: n.periodStart,
    periodEnd: n.periodEnd,
    premium: n.premium,
    commissionAmount: n.commissionAmount,
    type: n.type,
    writingAgentId: null,
    matchStatus: "unmatched" as const,
    raw: {
      ...n.raw,
      contactFirstName: n.contactFirstName,
      contactLastName: n.contactLastName,
      contactDob: n.contactDob,
      contactStateCode: n.contactStateCode,
    },
  }));
}

/** Insert the parsed lines in chunks. Returns the number inserted. */
export async function insertLineItems(
  executor: DbOrTx,
  statementId: string,
  orgId: string,
  normalized: NormalizedLineItem[],
): Promise<number> {
  const rows = toLineItemRows(statementId, orgId, normalized);
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await executor.insert(commissionLineItemsTable).values(rows.slice(i, i + CHUNK_SIZE));
  }
  return rows.length;
}
