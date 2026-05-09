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
 * Humana statement layout (V1):
 *   Pipe-delimited, headerless (their producer file format).
 *   Columns:
 *     0  PolicyNumber
 *     1  Last Name
 *     2  Member ID
 *     3  First Name
 *     4  DOB (m/d/yyyy)
 *     5  State
 *     6  Plan Code
 *     7  Plan Year
 *     8  Period Start
 *     9  Period End
 *    10  Premium
 *    11  Commission Amount
 *    12  Type (NEW / RENEWAL / CHGBK / BONUS)
 */
export function parseHumanaStatement(buffer: Buffer): NormalizedLineItem[] {
  const rows = parse(buffer, {
    delimiter: "|",
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
        memberId: cols[2] ? cols[2].trim() : null,
        policyNumber: cols[0] ? cols[0].trim() : null,
        planType: toPlanType(cols[6]),
        planYear,
        periodStart: toIsoDate(cols[8]),
        periodEnd: toIsoDate(cols[9]),
        premium: toMoney(cols[10]),
        commissionAmount: toRequiredMoney(cols[11]),
        type: toType(cols[12]),
        contactFirstName: cols[3] ? cols[3].trim() : null,
        contactLastName: cols[1] ? cols[1].trim() : null,
        contactDob: toIsoDate(cols[4]),
        contactStateCode: cols[5] ? cols[5].trim().toUpperCase() : null,
        raw: { columns: cols },
      } satisfies NormalizedLineItem;
    });
}
