/**
 * Work out what a statement file is without anyone typing it in: which carrier,
 * which period, which statement date.
 *
 * Everything here is deliberately conservative. When a signal is missing or
 * ambiguous the answer is `null`/an error and the file goes to the review list;
 * a wrong guess would post money to the wrong period or carrier.
 */
import { carrierFamily, type NormalizedLineItem } from "../commissionParsers";

export interface CarrierRef {
  id: string;
  name: string;
  isActive: boolean;
}

export type CarrierInference =
  | { ok: true; carrier: CarrierRef; via: "mapping" | "folder" | "filename" }
  | { ok: false; reason: string };

/**
 * Resolution order: an explicit mapping (by folder or file name), then the
 * folder name, then the filename. A hint resolves only when exactly ONE of the
 * org's active carriers belongs to the same parser family.
 */
export function inferCarrier(
  carriers: CarrierRef[],
  hints: { folderName: string | null; fileName: string },
  mapping: Record<string, string> = {},
): CarrierInference {
  const byId = new Map(carriers.map((c) => [c.id, c]));
  const lowered = new Map(Object.entries(mapping).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const hint of [hints.folderName, hints.fileName]) {
    const mapped = hint ? lowered.get(hint.trim().toLowerCase()) : undefined;
    if (mapped) {
      const c = byId.get(mapped);
      return c
        ? { ok: true, carrier: c, via: "mapping" }
        : { ok: false, reason: "Folder mapping points at a carrier that no longer exists" };
    }
  }

  const active = carriers.filter((c) => c.isActive);
  for (const [via, hint] of [
    ["folder", hints.folderName],
    ["filename", hints.fileName],
  ] as const) {
    const family = carrierFamily(hint);
    if (!family) continue;
    const matches = active.filter((c) => carrierFamily(c.name) === family);
    if (matches.length === 1) return { ok: true, carrier: matches[0], via };
    if (matches.length > 1) {
      return { ok: false, reason: `More than one carrier matches "${hint}"; add a folder mapping` };
    }
    return { ok: false, reason: `"${hint}" looks like ${family}, but the org has no active ${family} carrier` };
  }
  return { ok: false, reason: "Could not tell which carrier this is from the folder or file name" };
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validYear(y: number): boolean {
  return y >= 2000 && y <= 2100;
}

export interface Period {
  periodStart: string;
  periodEnd: string;
  source: "filename" | "lines";
}

/** A calendar month named in a filename: 2026-09, 202609, 09-2026, 09_2026, "September 2026", "Sep2026". */
export function monthFromFilename(fileName: string): { year: number; month: number } | null {
  const base = fileName.replace(/\.[A-Za-z0-9]+$/, "");

  const named = base.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s._-]*(\d{4})/i);
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase())) + 1;
    const year = Number(named[2]);
    if (month > 0 && validYear(year)) return { year, month };
  }
  const ymd = base.match(/(?<!\d)(\d{4})[-_.]?(0[1-9]|1[0-2])(?:[-_.]?(?:0[1-9]|[12]\d|3[01]))?(?!\d)/);
  if (ymd && validYear(Number(ymd[1]))) return { year: Number(ymd[1]), month: Number(ymd[2]) };
  const my = base.match(/(?<!\d)(0[1-9]|1[0-2])[-_.](\d{4})(?!\d)/);
  if (my && validYear(Number(my[2]))) return { year: Number(my[2]), month: Number(my[1]) };
  return null;
}

/**
 * The statement period. A month in the filename wins, since that is how
 * carriers and agencies label a pay cycle. Otherwise the most common
 * (periodStart, periodEnd) pair across the parsed lines, which tolerates the
 * odd back-dated chargeback.
 */
export function inferPeriod(fileName: string, lines: NormalizedLineItem[]): Period | null {
  const named = monthFromFilename(fileName);
  if (named) {
    return {
      periodStart: `${named.year}-${pad(named.month)}-01`,
      periodEnd: `${named.year}-${pad(named.month)}-${pad(lastDayOfMonth(named.year, named.month))}`,
      source: "filename",
    };
  }
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (l.periodStart && l.periodEnd) {
      const key = `${l.periodStart}|${l.periodEnd}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && key < best)) {
      best = key;
      bestCount = n;
    }
  }
  if (!best) return null;
  const [periodStart, periodEnd] = best.split("|");
  return { periodStart, periodEnd, source: "lines" };
}

/** An explicit full date in the filename (2026-09-30 / 20260930), else the file's modified date, else the period end. */
export function inferStatementDate(fileName: string, modifiedTime: Date | null, period: Period): string {
  const full = fileName.match(/(?<!\d)(\d{4})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (full && validYear(Number(full[1]))) return `${full[1]}-${full[2]}-${full[3]}`;
  if (modifiedTime && !Number.isNaN(modifiedTime.getTime())) return modifiedTime.toISOString().slice(0, 10);
  return period.periodEnd;
}

const SUPPORTED_EXTENSIONS = new Set(["csv", "txt", "psv", "dat"]);

/** The parsers read delimited text; anything else is surfaced for review instead of being silently skipped. */
export function isSupportedStatementFile(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.has(ext);
}
