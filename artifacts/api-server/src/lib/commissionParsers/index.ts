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

const PARSERS: Array<{ family: string; matcher: RegExp; parser: CommissionParser }> = [
  { family: "humana", matcher: /humana/i, parser: parseHumanaStatement },
  { family: "unitedhealth", matcher: /united\s*health|aarp|uhc/i, parser: parseUnitedHealthStatement },
  { family: "aetna", matcher: /aetna|cvs/i, parser: parseAetnaStatement },
  { family: "anthem", matcher: /anthem|bcbs|blue\s*cross/i, parser: parseAnthemStatement },
];

/**
 * The parser family a free-text name (a carrier row's name, a folder name, a
 * filename) belongs to, or null. Same matching rules as `parseStatement`, so a
 * name that maps to a family here is guaranteed to have a parser.
 */
export function carrierFamily(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const { family, matcher } of PARSERS) {
    if (matcher.test(t)) return family;
  }
  return null;
}

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
  // Strip currency formatting first, then detect accounting notation:
  // parentheses around a number denote a NEGATIVE amount, e.g. "(500.00)"
  // means -500.00. Carrier statements use this for chargebacks/recoupments,
  // so stripping the parens without negating silently turns a clawback into
  // a positive credit (see lib/commissionParsers/* + routes/clawbacks.ts,
  // which assume chargeback amounts are stored negative).
  const cleaned = String(raw).trim().replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const isParenNegative = /^\(.*\)$/.test(cleaned);
  const s = cleaned.replace(/[()]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const signed = isParenNegative && n > 0 ? -n : n;
  return signed.toFixed(2);
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
  // Trim before the exact-match short-code check so a trailing space or
  // line-ending in a CSV column doesn't classify CHGBK as 'initial'.
  // PR #49 caught that Humana's documented CHGBK code (and the common
  // "CB" abbreviation) didn't match "charge" / "recoup" / "reverse"
  // substrings, so chargebacks were silently classified as 'initial'
  // and miscredited. Match those explicit short codes too.
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "chgbk" || s === "cb") return "chargeback";
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
