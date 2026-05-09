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
 * Anthem / BCBS statement layout (V1):
 *   Headerless CSV.
 *   Columns:
 *     0  Last Name
 *     1  First Name
 *     2  DOB
 *     3  State
 *     4  Policy Number
 *     5  Member ID
 *     6  Plan Code
 *     7  Plan Year
 *     8  Period Start
 *     9  Period End
 *    10  Premium
 *    11  Commission Amount
 *    12  Type
 */
export function parseAnthemStatement(buffer: Buffer): NormalizedLineItem[] {
  const rows = parse(buffer, {
    delimiter: ",",
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as string[][];

  return rows
    .filter((cols) => cols.length >= 12 && cols.some((c) => (c ?? "").trim() !== ""))
    .map((cols) => {
      const planYearRaw = cols[7];
      const planYear = planYearRaw && /^\d{4}$/.test(planYearRaw) ? Number(planYearRaw) : null;
      return {
        memberId: cols[5] ? cols[5].trim() : null,
        policyNumber: cols[4] ? cols[4].trim() : null,
        planType: toPlanType(cols[6]),
        planYear,
        periodStart: toIsoDate(cols[8]),
        periodEnd: toIsoDate(cols[9]),
        premium: toMoney(cols[10]),
        commissionAmount: toRequiredMoney(cols[11]),
        type: toType(cols[12]),
        contactFirstName: cols[1] ? cols[1].trim() : null,
        contactLastName: cols[0] ? cols[0].trim() : null,
        contactDob: toIsoDate(cols[2]),
        contactStateCode: cols[3] ? cols[3].trim().toUpperCase() : null,
        raw: { columns: cols },
      } satisfies NormalizedLineItem;
    });
}
