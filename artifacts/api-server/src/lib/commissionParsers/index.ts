/**
 * Carrier statement parser registry.
 *
 * Each carrier has its own quirky CSV / pipe-delimited layout. This module
 * dispatches by carrier name (case-insensitive substring match) to a
 * normalizer that returns rows shaped like `commission_line_items`.
 *
 * Adding a carrier: drop a new file with a `parse` export and register it
 * in PARSERS below — no route layer changes required.
 */

export type CommissionLineItemType = "initial" | "renewal" | "bonus" | "chargeback";

export interface NormalizedLineItem {
  memberId: string | null;
  policyNumber: string | null;
  planType: string | null;
  planYear: number | null;
  periodStart: string | null; // ISO yyyy-mm-dd
  periodEnd: string | null;
  premium: string | null; // numeric as string for precision
  commissionAmount: string; // required
  type: CommissionLineItemType;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactDob: string | null; // ISO yyyy-mm-dd
  contactStateCode: string | null;
  raw: Record<string, unknown>;
}

export type CommissionParser = (buffer: Buffer) => NormalizedLineItem[];

import { parseHumanaStatement } from "./humana";
import { parseUnitedHealthStatement } from "./unitedhealth";
import { parseAetnaStatement } from "./aetna";
import { parseAnthemStatement } from "./anthem";

const PARSERS: Array<{ matcher: RegExp; parser: CommissionParser }> = [
  { matcher: /humana/i, parser: parseHumanaStatement },
  { matcher: /united\s*health|aarp|uhc/i, parser: parseUnitedHealthStatement },
  { matcher: /aetna|cvs/i, parser: parseAetnaStatement },
  { matcher: /anthem|bcbs|blue\s*cross/i, parser: parseAnthemStatement },
];

export class UnknownCarrierError extends Error {
  constructor(carrierName: string) {
    super(`No parser registered for carrier ${carrierName}`);
    this.name = "UnknownCarrierError";
  }
}

export function parseStatement(
  carrierName: string,
  buffer: Buffer,
): NormalizedLineItem[] {
  const trimmed = (carrierName ?? "").trim();
  for (const { matcher, parser } of PARSERS) {
    if (matcher.test(trimmed)) return parser(buffer);
  }
  throw new UnknownCarrierError(trimmed || "<unnamed>");
}

// ---- Shared helpers ----

export function toMoney(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

export function toRequiredMoney(raw: unknown): string {
  return toMoney(raw) ?? "0.00";
}

export function toIsoDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Try common US formats: m/d/yyyy, mm/dd/yyyy, yyyy-mm-dd
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

export function toType(raw: unknown): CommissionLineItemType {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("charge") || s.includes("recoup") || s.includes("reverse")) return "chargeback";
  if (s.includes("bonus") || s.includes("override")) return "bonus";
  if (s.includes("renew")) return "renewal";
  return "initial";
}

export function toPlanType(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).toUpperCase().trim();
  if (!s) return null;
  if (s.includes("MAPD")) return "MAPD";
  if (s.includes("PDP")) return "PDP";
  if (s === "MA" || s.startsWith("MA ")) return "MA";
  if (s.includes("SUPP") || s.includes("MEDIGAP")) return "supp";
  return "other";
}
