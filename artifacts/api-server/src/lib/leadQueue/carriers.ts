/**
 * Resolve a carrier reference to a agencyBRIDGE carrier id, org-scoped.
 *
 * External callers (GHL / Atlas) know a carrier by NAME, not by agencyBRIDGE's
 * opaque per-org `carriers.id`. The queue routes accept either `carrierId`
 * (verified to belong to the org and be active) or `carrierName`
 * (case-insensitive lookup among active carriers).
 *
 * `carriersTable` has no unique index on `(org_id, name)`, so a name can in
 * principle match multiple active rows — that is surfaced as `ambiguous`
 * rather than silently picking one (a wrong carrier means routing to the
 * wrong licensed pool).
 */
import { and, eq, sql } from "drizzle-orm";
import { db, carriersTable } from "@workspace/db";

export type ResolveCarrierInput = {
  orgId: string;
  carrierId?: string | null;
  carrierName?: string | null;
};

export type ResolveCarrierResult =
  | { ok: true; carrierId: string }
  | { ok: false; reason: "missing" | "not_found" | "ambiguous" };

export async function resolveCarrier(
  input: ResolveCarrierInput,
): Promise<ResolveCarrierResult> {
  const { orgId } = input;
  const carrierId = input.carrierId?.trim();
  const carrierName = input.carrierName?.trim();

  if (carrierId) {
    const [row] = await db
      .select({ id: carriersTable.id })
      .from(carriersTable)
      .where(
        and(
          eq(carriersTable.id, carrierId),
          eq(carriersTable.orgId, orgId),
          eq(carriersTable.isActive, true),
        ),
      )
      .limit(1);
    return row
      ? { ok: true, carrierId: row.id }
      : { ok: false, reason: "not_found" };
  }

  if (carrierName) {
    const matches = await db
      .select({ id: carriersTable.id })
      .from(carriersTable)
      .where(
        and(
          eq(carriersTable.orgId, orgId),
          eq(carriersTable.isActive, true),
          // Case-insensitive exact-name match.
          sql`lower(${carriersTable.name}) = lower(${carrierName})`,
        ),
      )
      .limit(2);
    if (matches.length === 0) return { ok: false, reason: "not_found" };
    if (matches.length > 1) return { ok: false, reason: "ambiguous" };
    return { ok: true, carrierId: matches[0].id };
  }

  return { ok: false, reason: "missing" };
}
