/**
 * Tolerant CSV parsing + field normalizers for the data-migration importers.
 *
 * Why not just `csv-parse`? With `columns: true` a single malformed quote
 * anywhere in the file (e.g. `"likes "golf`, or a note that opens a quote and
 * never closes it) throws, and the whole upload failed with
 * "Failed to parse CSV". Its `skip_records_with_error` mode does not recover
 * either: after a bad quote it swallows every remaining line. Agency exports
 * (GHL, carrier books, hand-edited Excel) hit this constantly.
 *
 * This parser isolates damage to the row it happens on:
 *   - every record is parsed independently; a record that cannot be parsed
 *     is re-read as its single physical line with quotes taken literally,
 *     kept (with a warning) if it has the right number of columns, and
 *     reported as a row-level error otherwise
 *   - rows with more values than the header are reported, not silently
 *     truncated (usually an unquoted comma inside an address)
 *
 * It also fixes several ways a file "parsed" into garbage without an error:
 *   - Excel .xlsx/.xls uploaded instead of CSV → clear file-level error
 *   - UTF-16 exports (Excel "Unicode Text") and Windows-1252 bytes → decoded
 *   - semicolon / tab / pipe delimited files → delimiter auto-detected
 *   - duplicate or blank header names → made unique, no column is dropped
 */

export type CsvIssueSeverity = "error" | "warning";

export interface CsvIssue {
  /** 1-based line number in the original file where the record starts. */
  row: number;
  field: string;
  message: string;
  severity: CsvIssueSeverity;
}

export interface TolerantCsvResult {
  headers: string[];
  rows: Record<string, string>[];
  /** `rowNumbers[i]` is the file line number `rows[i]` started on. */
  rowNumbers: number[];
  /** Row-level problems. Rows with `error` severity are NOT in `rows`. */
  issues: CsvIssue[];
  delimiter: string;
  encoding: string;
}

/** A problem with the file as a whole — nothing in it can be imported. */
export class CsvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFileError";
  }
}

// ─── Decoding ────────────────────────────────────────────────────────────────

function decode(buffer: Buffer): { text: string; encoding: string } {
  const b = buffer;
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    throw new CsvFileError(
      "This looks like an Excel workbook (.xlsx), not a CSV. In Excel choose File → Save As → CSV UTF-8, then upload that file.",
    );
  }
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    throw new CsvFileError(
      "This looks like an older Excel file (.xls), not a CSV. In Excel choose File → Save As → CSV UTF-8, then upload that file.",
    );
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(b.subarray(2)), encoding: "utf-16le" };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(b.subarray(2)), encoding: "utf-16be" };
  }
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  if (body.includes(0)) {
    throw new CsvFileError("This file contains binary data and is not a CSV. Export it from your system as CSV and try again.");
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    // Excel on Windows saves "CSV (Comma delimited)" as Windows-1252.
    return { text: new TextDecoder("windows-1252").decode(body), encoding: "windows-1252" };
  }
}

// ─── Delimiter detection ─────────────────────────────────────────────────────

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"];

function detectDelimiter(text: string): string {
  // Count candidates on the header line, outside quotes.
  const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    const n = counts.get(d)!;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

// ─── Record scanning ─────────────────────────────────────────────────────────

type ScanResult =
  | { ok: true; fields: string[]; next: number; linesSpanned: number }
  | { ok: false };

function isLineEnd(text: string, i: number): boolean {
  return i >= text.length || text[i] === "\n" || text[i] === "\r";
}

function skipLineEnd(text: string, i: number): number {
  if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
  if (text[i] === "\r" || text[i] === "\n") return i + 1;
  return i;
}

/**
 * Strict RFC-4180 scan of one record starting at `start`. A quote is only
 * special at the start of a field (after optional spaces); inside a quoted
 * field `""` is an escaped quote, and the closing quote must be followed by
 * optional spaces then a delimiter or line end. Anything else fails the
 * record so the caller can fall back to the single physical line.
 */
function scanRecord(text: string, start: number, delim: string): ScanResult {
  const fields: string[] = [];
  let i = start;
  let linesSpanned = 1;
  for (;;) {
    let j = i;
    while (text[j] === " ") j++;
    if (text[j] === '"') {
      j++;
      let value = "";
      for (;;) {
        if (j >= text.length) return { ok: false }; // quote never closed
        const c = text[j]!;
        if (c === '"') {
          if (text[j + 1] === '"') { value += '"'; j += 2; continue; }
          j++;
          while (text[j] === " ") j++;
          if (text[j] === delim || isLineEnd(text, j)) break;
          return { ok: false }; // stray text after closing quote
        }
        if (c === "\n") linesSpanned++;
        value += c;
        j++;
      }
      fields.push(value);
    } else {
      let k = j;
      while (k < text.length && text[k] !== delim && !isLineEnd(text, k)) k++;
      fields.push(text.slice(i, k));
      j = k;
    }
    if (text[j] === delim) { i = j + 1; continue; }
    return { ok: true, fields, next: skipLineEnd(text, j), linesSpanned };
  }
}

/** Fallback: the physical line only, quotes treated as ordinary characters. */
function scanLiteralLine(text: string, start: number, delim: string): { fields: string[]; next: number } {
  let end = start;
  while (!isLineEnd(text, end)) end++;
  const fields = text
    .slice(start, end)
    .split(delim)
    .map((f) => {
      const t = f.trim();
      if (!t.startsWith('"')) return t;
      // `"likes "golf` → `likes "golf`: drop the opening (and any closing) quote.
      return t.slice(1).replace(/"$/, "").replace(/""/g, '"');
    });
  return { fields, next: skipLineEnd(text, end) };
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, idx) => {
    const base = h.trim() || `Column ${idx + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

// ─── Public parser ───────────────────────────────────────────────────────────

export function parseCsvTolerant(buffer: Buffer): TolerantCsvResult {
  const { text, encoding } = decode(buffer);
  if (!text.trim()) throw new CsvFileError("The file is empty.");
  const delimiter = detectDelimiter(text);

  const records: { fields: string[]; line: number; warning?: string; error?: string }[] = [];
  let pos = 0;
  let line = 1;
  while (pos < text.length) {
    if (isLineEnd(text, pos)) { pos = skipLineEnd(text, pos); line++; continue; } // blank line
    const scanned = scanRecord(text, pos, delimiter);
    if (scanned.ok) {
      records.push({ fields: scanned.fields, line });
      pos = scanned.next;
      line += scanned.linesSpanned;
    } else {
      const literal = scanLiteralLine(text, pos, delimiter);
      records.push({ fields: literal.fields, line, warning: "Unbalanced quotation marks" });
      pos = literal.next;
      line++;
    }
  }

  const headerRecord = records.shift();
  if (!headerRecord) throw new CsvFileError("The file is empty.");
  const headers = uniqueHeaders(headerRecord.fields);

  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  const issues: CsvIssue[] = [];

  for (const rec of records) {
    const values = rec.fields.map((f) => f.trim());
    if (values.every((v) => v === "")) continue; // row of only delimiters
    // Trailing empty values beyond the header are usually padding, but they can
    // also be the tail of a row shifted by an unquoted comma — flag, don't drop.
    const rawLength = values.length;
    while (values.length > headers.length && values[values.length - 1] === "") values.pop();
    const shifted = rawLength > headers.length && values.length === headers.length && !rec.warning;

    if (values.length > headers.length) {
      issues.push({
        row: rec.line,
        field: "row",
        severity: "error",
        message: rec.warning
          ? `${rec.warning} — row could not be read. Check for a missing closing quote.`
          : `Row has ${values.length} values but the header has ${headers.length} columns — usually an unquoted comma inside a value (e.g. an address).`,
      });
      continue;
    }
    if (shifted) {
      issues.push({
        row: rec.line,
        field: "row",
        severity: "warning",
        message: "Row has more values than the header — if a value contains a comma (e.g. an address), columns may be shifted. Please double-check this row.",
      });
    }
    if (rec.warning) {
      issues.push({
        row: rec.line,
        field: "row",
        severity: "warning",
        message: `${rec.warning} — imported with quotes kept as typed. Please double-check this row.`,
      });
    }
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });
    rows.push(row);
    rowNumbers.push(rec.line);
  }

  return { headers, rows, rowNumbers, issues, delimiter, encoding };
}

// ─── Field normalizers ───────────────────────────────────────────────────────

/**
 * Parse the date formats agency exports actually contain into an ISO
 * `yyyy-mm-dd` string: ISO, US `m/d/yyyy` (or `-`/`.` separators), two-digit
 * years, and Excel serial day numbers. Returns null when unparseable or not
 * a real calendar date (so 02/30/1950 is rejected, not rolled into March).
 *
 * `twoDigitYear` decides the century for `m/d/yy`: a birth date is in the
 * past, an effective date is in this century.
 */
export function parseFlexibleDate(raw: string, twoDigitYear: "past" | "2000s" = "2000s"): string | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) {
    y = +match[1]!; m = +match[2]!; d = +match[3]!;
  } else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/))) {
    m = +match[1]!; d = +match[2]!; y = +match[3]!;
    if (match[3]!.length === 2) {
      const now = new Date().getUTCFullYear();
      y += 2000;
      // A birth date in a two-digit year that would make the person a minor
      // is a 1900s date (5/5/25 → 1925 for a Medicare beneficiary, not 2025).
      if (twoDigitYear === "past" && y > now - 18) y -= 100;
    }
  } else if ((match = s.match(/^\d{5}$/))) {
    // Excel serial date (days since 1899-12-30), plausible range 1900–2100.
    const serial = +s;
    if (serial < 1 || serial > 73050) return null;
    const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return dt.toISOString().slice(0, 10);
  } else {
    return null;
  }
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export type PlanType = "MA" | "PDP" | "MAPD" | "supp" | "other";

/** Map the many ways carriers and agencies spell a plan type onto the enum. */
export function normalizePlanType(raw: string): PlanType | null {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return null;
  const compact = s.replace(/ /g, "");
  if (["mapd", "mapdp", "maandpd", "medicareadvantageprescriptiondrug", "medicareadvantagewithpartd", "medicareadvantagepd"].includes(compact)) return "MAPD";
  if (["ma", "maonly", "medicareadvantage", "partc", "advantage", "dsnp", "csnp", "isnp", "snp", "hmo", "ppo", "pffs"].includes(compact)) return "MA";
  if (["pdp", "partd", "prescriptiondrugplan", "standalonepdp", "drugplan", "rx"].includes(compact)) return "PDP";
  if (compact.startsWith("medsupp") || compact.startsWith("medigap") || compact.startsWith("supp") || compact.startsWith("medicaresupplement") || /^plan[a-n]$/.test(compact)) return "supp";
  if (compact.includes("advantage") && (compact.includes("drug") || compact.includes("pd") || compact.includes("rx"))) return "MAPD";
  if (compact.includes("advantage")) return "MA";
  if (compact === "other") return "other";
  return null;
}

// CMS MBI format: 11 characters, positions 2,5,8,9 alphabetic; letters exclude
// S, L, O, I, B, Z. Commonly written with dashes as 4-3-4.
const MBI_ALPHA = "[AC-HJKMNP-RT-Y]";
const MBI_ALNUM = "[AC-HJKMNP-RT-Y0-9]";
const MBI_RE = new RegExp(`^[1-9]${MBI_ALPHA}${MBI_ALNUM}[0-9]${MBI_ALPHA}${MBI_ALNUM}[0-9]${MBI_ALPHA}${MBI_ALPHA}[0-9][0-9]$`);

/**
 * Canonical MBI for storage: uppercase, no spaces or dashes. Returns null if
 * the value is not a structurally valid MBI.
 */
export function canonicalMbi(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  return MBI_RE.test(s) ? s : null;
}

/** The 4-3-4 dashed spelling, for matching contacts entered by hand. */
export function dashedMbi(canonical: string): string {
  return `${canonical.slice(0, 4)}-${canonical.slice(4, 7)}-${canonical.slice(7)}`;
}

const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const US_STATE_CODES = new Set(Object.values(US_STATE_NAMES));

/** "Texas", "tx", "TX " → "TX". Null when not a US state. */
export function normalizeStateCode(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (US_STATE_CODES.has(upper)) return upper;
  return US_STATE_NAMES[s.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/**
 * US numbers → E.164 (`+15551234567`), the form Twilio sends as `From`, so an
 * inbound SMS resolves to the imported contact (webhooks.ts matches on exact
 * equality). Anything that is not a 10/11-digit US number is kept as typed.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // Letters mean it isn't a number (caller-ID display names like "JOHN DOE",
  // "Unknown", "Anonymous") — storing it would poison phone-based dedupe.
  // A trailing extension ("x123", "ext. 4") is allowed.
  if (/[a-z]/i.test(s.replace(/\s*(x|ext\.?|extension)\s*\d+\s*$/i, ""))) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return s;
}
