import { describe, it, expect } from "vitest";
import {
  parseCsvTolerant,
  CsvFileError,
  parseFlexibleDate,
  normalizePlanType,
  canonicalMbi,
  normalizeStateCode,
  normalizePhone,
} from "../../lib/csvImport";

const csv = (s: string) => Buffer.from(s, "utf8");

describe("parseCsvTolerant", () => {
  it("parses a normal file with quoted commas and multi-line notes", () => {
    const r = parseCsvTolerant(csv('first_name,last_name,address1,notes\nJane,Doe,"12 Main St, Apt 4","line one\nline two"\nJohn,Roe,5 Elm,\n'));
    expect(r.headers).toEqual(["first_name", "last_name", "address1", "notes"]);
    expect(r.rows).toEqual([
      { first_name: "Jane", last_name: "Doe", address1: "12 Main St, Apt 4", notes: "line one\nline two" },
      { first_name: "John", last_name: "Roe", address1: "5 Elm", notes: "" },
    ]);
    // Row numbers are file lines, not array index + 2: row 2 spans two lines.
    expect(r.rowNumbers).toEqual([2, 4]);
    expect(r.issues).toEqual([]);
  });

  // The "Failed to parse CSV" bug: csv-parse threw on any one of these and
  // the whole file was rejected.
  it("isolates a stray quote to its own row instead of failing the file", () => {
    const r = parseCsvTolerant(csv('first_name,last_name,notes\nA,One,"likes "golf\nB,Two,ok\n'));
    expect(r.rows.map((x) => x.first_name)).toEqual(["A", "B"]);
    expect(r.rows[0]!.notes).toBe('likes "golf');
    expect(r.issues).toEqual([expect.objectContaining({ row: 2, severity: "warning" })]);
  });

  it("does not let an unclosed quote swallow the rest of the file", () => {
    const r = parseCsvTolerant(csv('first_name,last_name,notes\nA,One,"never closed\nB,Two,ok\nC,Three,ok\n'));
    expect(r.rows.map((x) => x.first_name)).toEqual(["A", "B", "C"]);
    expect(r.rowNumbers).toEqual([2, 3, 4]);
  });

  it("reports a row with too many values as a row-level error", () => {
    const r = parseCsvTolerant(csv("first_name,last_name,address1\nA,One,12 Main St, Apt 4\nB,Two,5 Elm\n"));
    expect(r.rows.map((x) => x.first_name)).toEqual(["B"]);
    expect(r.issues).toEqual([expect.objectContaining({ row: 2, severity: "error" })]);
  });

  it("pads short rows; flags (but keeps) rows with extra trailing blanks", () => {
    const r = parseCsvTolerant(csv("a,b,c\n1,2\n3,4,5,,\n"));
    expect(r.rows).toEqual([{ a: "1", b: "2", c: "" }, { a: "3", b: "4", c: "5" }]);
    expect(r.issues).toEqual([expect.objectContaining({ row: 3, severity: "warning" })]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(parseCsvTolerant(csv("first;last\nA;B\n")).rows).toEqual([{ first: "A", last: "B" }]);
    expect(parseCsvTolerant(csv("first\tlast\nA\tB\n")).rows).toEqual([{ first: "A", last: "B" }]);
  });

  it("decodes UTF-16 (Excel Unicode Text) and Windows-1252", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("first\tlast\nJosé\tB\n", "utf16le")]);
    expect(parseCsvTolerant(utf16).rows).toEqual([{ first: "José", last: "B" }]);
    const win1252 = Buffer.from([...Buffer.from("first,last\nJos"), 0xe9, ...Buffer.from(",B\n")]);
    expect(parseCsvTolerant(win1252).rows).toEqual([{ first: "José", last: "B" }]);
  });

  it("strips a UTF-8 BOM and handles CRLF line endings", () => {
    const r = parseCsvTolerant(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv("first,last\r\nA,B\r\n")]));
    expect(r.headers).toEqual(["first", "last"]);
    expect(r.rows).toEqual([{ first: "A", last: "B" }]);
  });

  it("keeps every column when headers repeat or are blank", () => {
    const r = parseCsvTolerant(csv("Phone,Phone,\n1,2,3\n"));
    expect(r.headers).toEqual(["Phone", "Phone (2)", "Column 3"]);
    expect(r.rows[0]).toEqual({ Phone: "1", "Phone (2)": "2", "Column 3": "3" });
  });

  it("rejects Excel workbooks and empty files with a clear message", () => {
    expect(() => parseCsvTolerant(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toThrow(/Excel workbook/);
    expect(() => parseCsvTolerant(csv("  \n"))).toThrow(CsvFileError);
  });
});

describe("field normalizers", () => {
  it("parses common date formats and rejects impossible dates", () => {
    expect(parseFlexibleDate("1950-03-07")).toBe("1950-03-07");
    expect(parseFlexibleDate("3/7/1950")).toBe("1950-03-07");
    expect(parseFlexibleDate("03-07-1950")).toBe("1950-03-07");
    expect(parseFlexibleDate("1/1/26")).toBe("2026-01-01");
    expect(parseFlexibleDate("3/7/50", "past")).toBe("1950-03-07");
    // Two-digit birth years resolve to the century giving a plausible adult age.
    expect(parseFlexibleDate("5/5/25", "past")).toBe("1925-05-05");
    expect(parseFlexibleDate("5/5/24", "past")).toBe("1924-05-05");
    expect(parseFlexibleDate("5/5/05", "past")).toBe("2005-05-05"); // 21 — e.g. an SSDI beneficiary
    expect(parseFlexibleDate("5/5/10", "past")).toBeNull(); // 16 or 116: ambiguous, ask for 4 digits
    expect(parseFlexibleDate("46023")).toBe("2026-01-01"); // Excel serial
    expect(parseFlexibleDate("2/30/1950")).toBeNull();
    expect(parseFlexibleDate("next tuesday")).toBeNull();
  });

  it("maps plan type spellings onto the enum", () => {
    expect(normalizePlanType("MAPD")).toBe("MAPD");
    expect(normalizePlanType("MA-PD")).toBe("MAPD");
    expect(normalizePlanType("Medicare Advantage")).toBe("MA");
    expect(normalizePlanType("Medicare Advantage Prescription Drug")).toBe("MAPD");
    expect(normalizePlanType("Part D")).toBe("PDP");
    expect(normalizePlanType("Med Supp")).toBe("supp");
    expect(normalizePlanType("Medigap Plan G")).toBe("supp");
    expect(normalizePlanType("Plan G")).toBe("supp");
    expect(normalizePlanType("D-SNP")).toBe("MA");
    expect(normalizePlanType("dental")).toBeNull();
  });

  it("validates and canonicalizes MBIs", () => {
    expect(canonicalMbi("1EG4-TE5-MK73")).toBe("1EG4TE5MK73");
    expect(canonicalMbi(" 1eg4te5mk73 ")).toBe("1EG4TE5MK73");
    expect(canonicalMbi("123-45-6789")).toBeNull(); // SSN-shaped
    expect(canonicalMbi("1SG4TE5MK73")).toBeNull(); // S is never used
  });

  it("normalizes states and phones", () => {
    expect(normalizeStateCode("texas")).toBe("TX");
    expect(normalizeStateCode("tx")).toBe("TX");
    expect(normalizeStateCode("Ontario")).toBeNull();
    expect(normalizePhone("(512) 555-0100")).toBe("+15125550100");
    expect(normalizePhone("1-512-555-0100")).toBe("+15125550100");
    expect(normalizePhone("")).toBeNull();
  });
});

