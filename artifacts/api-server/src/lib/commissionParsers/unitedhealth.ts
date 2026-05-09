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
 * UnitedHealth / AARP statement layout (V1):
 *   Standard CSV, headerless.
 *   Columns:
 *     0  Member ID
 *     1  Subscriber Last Name
 *     2  Subscriber First Name
 *     3  DOB
 *     4  State
 *     5  Policy Number
 *     6  Plan Code
 *     7  Plan Year
 *     8  Period Start
 *     9  Period End
 *    10  Premium
 *    11  Commission Amount
 *    12  Transaction Type
 */
export function parseUnitedHealthStatement(buffer: Buffer): NormalizedLineItem[] {
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
        memberId: cols[0] ? cols[0].trim() : null,
        policyNumber: cols[5] ? cols[5].trim() : null,
        planType: toPlanType(cols[6]),
        planYear,
        periodStart: toIsoDate(cols[8]),
        periodEnd: toIsoDate(cols[9]),
        premium: toMoney(cols[10]),
        commissionAmount: toRequiredMoney(cols[11]),
        type: toType(cols[12]),
        contactFirstName: cols[2] ? cols[2].trim() : null,
        contactLastName: cols[1] ? cols[1].trim() : null,
        contactDob: toIsoDate(cols[3]),
        contactStateCode: cols[4] ? cols[4].trim().toUpperCase() : null,
        raw: { columns: cols },
      } satisfies NormalizedLineItem;
    });
}
