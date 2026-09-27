/**
 * The ONE place a commission statement's shown status is derived.
 *
 * `commission_statements.status` records how far the PIPELINE got
 * (pending → parsed → reconciled). "reconciled" only means the reconcile
 * worker ran and matched lines to clients/agents — it says nothing about
 * whether the carrier's stated total agrees with the lines it sent. A
 * statement whose lines add up to $574.50 less than its total therefore used
 * to show a green "Reconciled".
 *
 * `displayStatus` fixes that for every surface (statement list, statement
 * detail, Reconciliation page):
 *   - "reconciled_with_variance" when reconciled but |total − Σ lines| ≥ $0.01
 *   - otherwise the stored status.
 */

/** Smallest difference (dollars) treated as a real variance. */
export const VARIANCE_TOLERANCE = 0.01;

export type StatementDisplayStatus =
  | "pending"
  | "parsed"
  | "reconciled"
  | "reconciled_with_variance"
  | (string & {});

function money(v: number): number {
  return Number(v.toFixed(2));
}

/**
 * Carrier total minus the sum of parsed line items, or null when there is
 * nothing to compare (no stated total, or no lines parsed yet).
 */
export function statementVariance(
  totalAmount: string | number | null | undefined,
  lineItemTotal: string | number | null | undefined,
  lineItemCount: number,
): number | null {
  if (totalAmount == null || lineItemCount <= 0) return null;
  const total = Number(totalAmount);
  const lines = Number(lineItemTotal ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(lines)) return null;
  return money(total - lines);
}

export function hasVariance(variance: number | null): boolean {
  return variance != null && Math.abs(variance) >= VARIANCE_TOLERANCE;
}

export function displayStatementStatus(
  status: string,
  variance: number | null,
): StatementDisplayStatus {
  if (status === "reconciled" && hasVariance(variance)) return "reconciled_with_variance";
  return status;
}
