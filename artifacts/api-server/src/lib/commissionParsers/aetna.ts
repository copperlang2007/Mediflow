import { parse } from "csv-parse/sync";
import {
  type NormalizedLineItem,
  toIsoDate,
  toMoney,
  toPlanType,
  toRequiredMoney,
  toType,
} from "./index";

/**
 * Aetna / CVS statement layout (V1):
 *   Header-row CSV. Looks for known field names case-insensitively.
 *   Required: "Member ID" (or "Member Id"), "Commission Amount".
 */
export function parseAetnaStatement(buffer: Buffer): NormalizedLineItem[] {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const indexLower = (row: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.toLowerCase().replace(/\s+/g, " ").trim()] = v;
    }
    return out;
  };

  const pick = (row: Record<string, string>, ...keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };

  return records.map((rawRow) => {
    const row = indexLower(rawRow);
    const planYearRaw = pick(row, "plan year", "year");
    const planYear = planYearRaw && /^\d{4}$/.test(planYearRaw) ? Number(planYearRaw) : null;
    return {
      memberId: pick(row, "member id"),
      policyNumber: pick(row, "policy number", "policy id"),
      planType: toPlanType(pick(row, "plan type", "plan code", "plan")),
      planYear,
      periodStart: toIsoDate(pick(row, "period start", "from date", "start date")),
      periodEnd: toIsoDate(pick(row, "period end", "to date", "end date")),
      premium: toMoney(pick(row, "premium", "monthly premium")),
      commissionAmount: toRequiredMoney(pick(row, "commission amount", "commission", "amount")),
      type: toType(pick(row, "type", "transaction type", "txn type")),
      contactFirstName: pick(row, "first name", "subscriber first name"),
      contactLastName: pick(row, "last name", "subscriber last name"),
      contactDob: toIsoDate(pick(row, "dob", "date of birth")),
      contactStateCode: (pick(row, "state", "state code") ?? "").toUpperCase() || null,
      raw: rawRow,
    } satisfies NormalizedLineItem;
  });
}
