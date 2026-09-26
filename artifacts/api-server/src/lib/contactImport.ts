/**
 * Generic CSV contact import: row interpretation, duplicate matching, and the
 * write path for contacts + enrollments.
 *
 * `interpretContactRow` is the single source of truth for what a row means.
 * The validate step and the background worker both call it, so the preview
 * the admin approves is exactly what gets written.
 *
 * Duplicate matching (validate preview, and dedupe on confirm):
 *   1. Medicare ID (via the HMAC blind index) — unique per beneficiary.
 *   2. Email, then phone — but only when the first name also matches.
 *   3. First + last name + date of birth, for rows with no other identifier.
 *      Medicare households routinely share one phone and one email; matching
 *      on those alone would merge a husband into his wife's record, and her
 *      enrollment onto him.
 * Rows earlier in the same file count as existing contacts, so a file that
 * lists a beneficiary twice (MA + PDP on separate rows) yields one contact
 * with two enrollments.
 *
 * "merge" only fills blanks on the existing contact. An import never
 * overwrites data an agent already entered by hand.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  carriersTable,
  contactsTable,
  enrollmentsTable,
  importJobsTable,
} from "@workspace/db";
import {
  decryptMedicareId,
  encryptMedicareId,
  hashMedicareId,
} from "@workspace/db/encryption/medicareId";
import {
  canonicalMbi,
  dashedMbi,
  normalizePhone,
  normalizePlanType,
  normalizeStateCode,
  parseFlexibleDate,
  type CsvIssue,
  type PlanType,
} from "./csvImport";
import { syncContactCoverageProjection } from "../routes/enrollments";
import { logger } from "./logger";
import { captureWorkerError } from "./sentry";

export type DuplicateAction = "merge" | "skip" | "create_new";

export function parseDuplicateAction(raw: unknown): DuplicateAction {
  return raw === "skip" || raw === "create_new" ? raw : "merge";
}

/** Reserved row key carrying the original file line number. */
export const ROW_NUMBER_KEY = "__row";
/** Prefix marking a Medicare ID cell that was encrypted before being queued. */
const ENCRYPTED_CELL_PREFIX = "enc:";

export const CONTACT_TARGET_FIELDS = [
  { field: "firstName", label: "First Name", required: true },
  { field: "lastName", label: "Last Name", required: true },
  { field: "fullName", label: "Full Name (auto-split)" },
  { field: "email", label: "Email" },
  { field: "phone", label: "Phone" },
  { field: "dob", label: "Date of Birth" },
  { field: "address1", label: "Street Address" },
  { field: "city", label: "City" },
  { field: "county", label: "County" },
  { field: "stateCode", label: "State" },
  { field: "zipCode", label: "ZIP Code" },
  { field: "medicareId", label: "Medicare ID (MBI) — stored encrypted" },
  { field: "carrier", label: "Carrier" },
  { field: "planName", label: "Plan Name" },
  { field: "planType", label: "Plan Type (MA, MAPD, PDP, Supplement)" },
  { field: "effectiveDate", label: "Effective Date" },
  { field: "assignedAgentEmail", label: "Assigned Agent (email)" },
  { field: "leadSource", label: "Lead Source" },
  { field: "tags", label: "Tags" },
  { field: "optOut", label: "Opt-Out (yes/true = opt out)" },
] as const;

/** Guess the target field for a CSV header. Order matters: specific first. */
export function suggestContactField(header: string): string {
  const h = header.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (h.includes("agent") || h.includes("owner") || h === "assigned_to" || h === "assigned") {
    return h.includes("email") || h === "assigned_to" || h === "assigned" || h === "agent" || h === "owner" ? "assignedAgentEmail" : "";
  }
  if (["first_name", "firstname", "first", "fname", "given_name"].includes(h)) return "firstName";
  if (["last_name", "lastname", "last", "lname", "surname", "family_name"].includes(h)) return "lastName";
  if (["name", "full_name", "fullname", "client_name", "member_name", "contact_name", "beneficiary_name"].includes(h)) return "fullName";
  if (h.includes("email")) return "email";
  if (h.includes("phone") || h === "mobile" || h === "cell") return "phone";
  if (h === "dob" || h.includes("birth")) return "dob";
  if (h.includes("medicare") || h === "mbi" || h === "hicn" || h === "medicare_id") return "medicareId";
  // "Address City" / "address_zip" are parts of an address, not the street line.
  if (h.startsWith("address_") || h.startsWith("mailing_")) {
    const part = h.replace(/^(mailing_)?(address_)?/, "");
    if (part === "city" || part === "town") return "city";
    if (part === "state" || part === "state_code" || part === "st") return "stateCode";
    if (part === "county") return "county";
    if (part.includes("zip") || part.includes("postal")) return "zipCode";
  }
  if (h.startsWith("address") || h.startsWith("street") || h === "addr" || h === "addr1") return h.endsWith("2") ? "" : "address1";
  if (h === "city" || h === "town") return "city";
  if (h === "county") return "county";
  if (h === "state" || h === "state_code" || h === "st") return "stateCode";
  if (h.includes("zip") || h.includes("postal")) return "zipCode";
  if (h.includes("carrier") || h === "insurance_company") return "carrier";
  if (h === "plan_type" || h === "product" || h === "product_type" || h === "coverage_type" || h === "lob" || h === "line_of_business") return "planType";
  if (h === "plan_name" || h === "plan") return "planName";
  if (h.includes("effective") || h === "eff_date") return "effectiveDate";
  if (h.includes("source")) return "leadSource";
  if (h.includes("opt_out") || h.includes("optout")) return "optOut";
  if (h.includes("tag")) return "tags";
  return "";
}

// ─── Row interpretation ──────────────────────────────────────────────────────

export interface InterpretedContact {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dob: string | null;
  address1: string | null;
  city: string | null;
  county: string | null;
  stateCode: string | null;
  zipCode: string | null;
  leadSource: string | null;
  tags: string[];
  optOut: boolean;
  /** Canonical (dash-free) MBI, validated against the CMS format. */
  mbi: string | null;
  assignedAgentEmail: string | null;
}

export interface InterpretedEnrollment {
  carrierName: string | null;
  planName: string | null;
  planType: PlanType;
  effectiveDate: string;
  planYear: number;
}

export interface InterpretedRow {
  row: number;
  /** Null when the row cannot be imported at all (an `error` issue explains why). */
  contact: InterpretedContact | null;
  enrollment: InterpretedEnrollment | null;
  issues: CsvIssue[];
}

const UNIT_IN_CITY = /^(?:(?:apt|apartment|suite|ste|unit|bldg|building|fl|floor|lot|rm|room|space|spc|trlr)\.?\s*#?\s*(?:\d|[a-z](?![a-z.]))|#\s*\d)/i;

export function interpretContactRow(
  raw: Record<string, string>,
  mapping: Record<string, string>,
  rowNumber: number,
  /** Column-shift detection is a CSV concern; JSON payloads have no columns. */
  opts: { detectShift?: boolean } = { detectShift: true },
): InterpretedRow {
  // Messages name the field but never echo the value: they persist to
  // import_jobs.errors and the downloadable errors CSV, and values here are PHI.
  const issues: CsvIssue[] = [];
  const warn = (field: string, message: string) => issues.push({ row: rowNumber, field, message, severity: "warning" });
  // An unquoted comma in the street address pushes every later column one to
  // the right, so the address block fails together: State gets the city and
  // ZIP gets the state. That pair (or a unit designator in City) is the shift
  // signature. Unrelated typos (bad email + bad DOB) are not a shift — those
  // fields are just left blank with a warning.
  let stateInvalid = false;
  let zipInvalid = false;
  const get = (field: string): string => {
    const col = Object.keys(mapping).find((k) => mapping[k] === field);
    return col ? (raw[col] ?? "").trim() : "";
  };

  let firstName = get("firstName");
  let lastName = get("lastName");
  const fullName = get("fullName").replace(/\s+/g, " ");
  if ((!firstName || !lastName) && fullName) {
    if (fullName.includes(",")) {
      // "Doe, Jane" — the usual carrier-report order.
      const [last, first] = fullName.split(",").map((s) => s.trim());
      firstName ||= first ?? "";
      lastName ||= last ?? "";
    } else {
      const parts = fullName.split(" ");
      firstName ||= parts[0] ?? "";
      lastName ||= parts.slice(1).join(" ");
    }
  }
  if (!firstName || !lastName) {
    issues.push({
      row: rowNumber,
      field: !firstName ? "firstName" : "lastName",
      severity: "error",
      message: `${!firstName ? "First" : "Last"} name is required — row skipped`,
    });
    return { row: rowNumber, contact: null, enrollment: null, issues };
  }

  let email: string | null = get("email") || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    warn("email", "Email is not a valid address — left blank");
    email = null;
  }

  const phoneRaw = get("phone");
  const phone = normalizePhone(phoneRaw);
  if (phoneRaw && !phone) warn("phone", "Phone is not a recognizable number — left blank");

  let dob: string | null = null;
  const dobRaw = get("dob");
  if (dobRaw) {
    dob = parseFlexibleDate(dobRaw, "past");
    if (!dob) {
      warn("dob", "Date of birth not recognized — use MM/DD/YYYY (four-digit year). Left blank");
    } else if (dob > new Date().toISOString().slice(0, 10)) {
      warn("dob", "Date of birth is in the future — left blank");
      dob = null;
    }
  }

  let stateCode: string | null = null;
  const stateRaw = get("stateCode");
  if (stateRaw) {
    stateCode = normalizeStateCode(stateRaw);
    if (!stateCode) {
      warn("stateCode", "State is not a US state — left blank");
      stateInvalid = true;
    }
  }

  let zipCode: string | null = get("zipCode") || null;
  if (zipCode) {
    // Excel drops leading zeros (02134 → 2134); restore them.
    if (/^\d{3,4}$/.test(zipCode)) zipCode = zipCode.padStart(5, "0");
    if (!/^\d{5}(-?\d{4})?$/.test(zipCode)) {
      warn("zipCode", "ZIP code is not a 5- or 9-digit ZIP — left blank");
      zipCode = null;
      zipInvalid = true;
    }
  }

  let mbi: string | null = null;
  let mbiRaw = get("medicareId");
  if (mbiRaw.startsWith(ENCRYPTED_CELL_PREFIX)) {
    mbiRaw = decryptMedicareId(Buffer.from(mbiRaw.slice(ENCRYPTED_CELL_PREFIX.length), "base64"));
  }
  if (mbiRaw) {
    mbi = canonicalMbi(mbiRaw);
    // Never echo the value back: it is PHI and this message lands in logs and error CSVs.
    if (!mbi) warn("medicareId", "Medicare ID is not a valid 11-character MBI — not saved");
  }

  let assignedAgentEmail: string | null = get("assignedAgentEmail").toLowerCase() || null;
  if (assignedAgentEmail && !assignedAgentEmail.includes("@")) {
    warn("assignedAgentEmail", "Assigned agent must be an email address — left unassigned");
    assignedAgentEmail = null;
  }

  // "12 Main St, Suite 100" with an unquoted comma puts "Suite 100" in City.
  // A city never starts with a unit designator, so this is a shift on its own,
  // even when every other shifted value happens to validate.
  const cityRaw = get("city");
  // The designator must be followed by a unit number ("Suite 100", "Apt 5",
  // "Unit 3B", "#42", "Apt B") — so real towns like "Ste. Genevieve", "Ste.
  // Marie" or "Unit, WV" are not mistaken for a unit.
  if (opts.detectShift !== false && cityRaw && UNIT_IN_CITY.test(cityRaw)) {
    issues.push({
      row: rowNumber,
      field: "row",
      severity: "error",
      message: "City looks like an apartment/suite number — the row looks shifted (the address was probably split by an unquoted comma). Row skipped; fix it and re-import.",
    });
    return { row: rowNumber, contact: null, enrollment: null, issues };
  }

  if (opts.detectShift !== false && stateInvalid && zipInvalid) {
    issues.push({
      row: rowNumber,
      field: "row",
      severity: "error",
      message: "State and ZIP are both invalid — the row looks shifted (often an unquoted comma in the street address). Row skipped; fix it and re-import.",
    });
    return { row: rowNumber, contact: null, enrollment: null, issues };
  }

  const tagsRaw = get("tags");
  const optOutRaw = get("optOut").toLowerCase();

  const contact: InterpretedContact = {
    firstName,
    lastName,
    email,
    phone,
    dob,
    address1: get("address1") || null,
    city: get("city") || null,
    county: get("county") || null,
    stateCode,
    zipCode,
    leadSource: get("leadSource") || null,
    tags: tagsRaw ? tagsRaw.split(/[,;]/).map((t) => t.trim()).filter(Boolean) : [],
    optOut: ["yes", "y", "true", "1"].includes(optOutRaw),
    mbi,
    assignedAgentEmail,
  };

  // Enrollment: only attempted when the row carries coverage data.
  const carrierName = get("carrier") || null;
  const planName = get("planName") || null;
  const planTypeRaw = get("planType");
  const effectiveRaw = get("effectiveDate");
  let enrollment: InterpretedEnrollment | null = null;
  if (carrierName || planName || planTypeRaw || effectiveRaw) {
    const planType = planTypeRaw ? normalizePlanType(planTypeRaw) : null;
    const effectiveDate = effectiveRaw ? parseFlexibleDate(effectiveRaw, "2000s") : null;
    if (!planType) {
      warn("planType", planTypeRaw
        ? "Plan type not recognized (use MA, MAPD, PDP, Supplement, or Other) — contact imported without enrollment"
        : "Plan type is missing — contact imported without enrollment");
    }
    if (!effectiveDate) {
      warn("effectiveDate", effectiveRaw
        ? "Effective date not recognized — use MM/DD/YYYY. Contact imported without enrollment"
        : "Effective date is missing — contact imported without enrollment");
    }
    if (planType && effectiveDate) {
      enrollment = { carrierName, planName, planType, effectiveDate, planYear: Number(effectiveDate.slice(0, 4)) };
    }
  }

  return { row: rowNumber, contact, enrollment, issues };
}

// ─── Duplicate matching ──────────────────────────────────────────────────────

interface KnownContact {
  id: string;
  firstName: string;
  lastName: string;
  dob: string | null;
  email: string | null;
  phone: string | null;
  /** Row number when the contact came from earlier in the same file. */
  fromRow?: number;
}

export class ContactMatcher {
  private byMbiHash = new Map<string, KnownContact>();
  private byEmail = new Map<string, KnownContact[]>();
  private byPhone = new Map<string, KnownContact[]>();
  private byNameDob = new Map<string, KnownContact>();

  add(c: KnownContact, mbiHashes: Buffer[] = []): void {
    for (const h of mbiHashes) this.byMbiHash.set(h.toString("hex"), c);
    if (c.dob) this.byNameDob.set(nameDobKey(c.firstName, c.lastName, c.dob), c);
    if (c.email) push(this.byEmail, c.email.toLowerCase(), c);
    if (c.phone) {
      push(this.byPhone, c.phone, c);
      const e164 = normalizePhone(c.phone);
      if (e164 && e164 !== c.phone) push(this.byPhone, e164, c);
    }
  }

  find(contact: InterpretedContact): { match: KnownContact; reason: string } | null {
    if (contact.mbi) {
      for (const h of mbiHashesFor(contact.mbi)) {
        const m = this.byMbiHash.get(h.toString("hex"));
        if (m) return { match: m, reason: "Medicare ID" };
      }
    }
    // A shared phone/email alone is not identity: households, Sr/Jr and care
    // facilities share them. Require the first name, plus the DOB when both
    // sides have one (distinguishes Sr/Jr), otherwise the last name.
    const lower = (s: string) => s.trim().toLowerCase();
    const sameName = (k: KnownContact) =>
      lower(k.firstName) === lower(contact.firstName) &&
      (k.dob && contact.dob ? k.dob === contact.dob : lower(k.lastName) === lower(contact.lastName));
    if (contact.email) {
      const m = (this.byEmail.get(contact.email.toLowerCase()) ?? []).find(sameName);
      if (m) return { match: m, reason: "email + name" };
    }
    if (contact.phone) {
      const m = (this.byPhone.get(contact.phone) ?? []).find(sameName);
      if (m) return { match: m, reason: "phone + name" };
    }
    if (contact.dob) {
      const m = this.byNameDob.get(nameDobKey(contact.firstName, contact.lastName, contact.dob));
      if (m) return { match: m, reason: "name + date of birth" };
    }
    return null;
  }
}

function nameDobKey(first: string, last: string, dob: string): string {
  return `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}|${dob}`;
}

/** Rows with none of these can't be checked for duplicates. */
function hasMatchKey(c: InterpretedContact): boolean {
  return !!(c.mbi || c.email || c.phone || c.dob);
}

function known(id: string, c: InterpretedContact, fromRow?: number): KnownContact {
  return { id, firstName: c.firstName, lastName: c.lastName, dob: c.dob, email: c.email, phone: c.phone, fromRow };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Contacts entered by hand keep whatever spelling the agent typed, and the
 * hash is over that spelling. Check both the canonical and the 4-3-4 dashed
 * forms so an import finds either.
 */
function mbiHashesFor(canonical: string): Buffer[] {
  return [hashMedicareId(canonical), hashMedicareId(dashedMbi(canonical))];
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Anything that can run a select: the pool, or an open transaction. */
type Executor = typeof db | Tx;

const LOOKUP_CHUNK = 500;

/** Load the org's contacts that could match any row in `rows`. */
export async function loadMatcher(
  orgId: string,
  rows: InterpretedContact[],
  exec: Executor = db,
  /** `deleted: true` matches against soft-deleted contacts instead of live ones. */
  opts: { deleted?: boolean } = {},
): Promise<ContactMatcher> {
  const matcher = new ContactMatcher();
  const hashes = rows.flatMap((r) => (r.mbi ? mbiHashesFor(r.mbi) : []));
  const emails = [...new Set(rows.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e))];
  const phones = [...new Set(rows.flatMap((r) => (r.phone ? [r.phone, r.phone.replace(/^\+1/, "")] : [])))];
  const lastNames = [...new Set(rows.filter((r) => r.dob).map((r) => r.lastName.toLowerCase()))];

  const selectCols = {
    id: contactsTable.id,
    firstName: contactsTable.firstName,
    lastName: contactsTable.lastName,
    dob: contactsTable.dob,
    email: contactsTable.email,
    phone: contactsTable.phone,
    medicareIdHash: contactsTable.medicareIdHash,
  };
  const found = new Map<string, { id: string; firstName: string; lastName: string; dob: Date | null; email: string | null; phone: string | null; medicareIdHash: Buffer | Uint8Array | null }>();
  const run = async (cond: ReturnType<typeof inArray>) => {
    const res = await exec.select(selectCols).from(contactsTable)
      .where(and(eq(contactsTable.orgId, orgId), opts.deleted ? isNotNull(contactsTable.deletedAt) : isNull(contactsTable.deletedAt), cond));
    for (const r of res) found.set(r.id, r);
  };
  for (let i = 0; i < hashes.length; i += LOOKUP_CHUNK) await run(inArray(contactsTable.medicareIdHash, hashes.slice(i, i + LOOKUP_CHUNK)));
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) await run(inArray(sql`lower(${contactsTable.email})`, emails.slice(i, i + LOOKUP_CHUNK)));
  for (let i = 0; i < phones.length; i += LOOKUP_CHUNK) await run(inArray(contactsTable.phone, phones.slice(i, i + LOOKUP_CHUNK)));
  for (let i = 0; i < lastNames.length; i += LOOKUP_CHUNK) await run(inArray(sql`lower(${contactsTable.lastName})`, lastNames.slice(i, i + LOOKUP_CHUNK)));

  for (const c of found.values()) {
    matcher.add(
      { id: c.id, firstName: c.firstName, lastName: c.lastName, dob: c.dob ? c.dob.toISOString().slice(0, 10) : null, email: c.email, phone: c.phone },
      c.medicareIdHash ? [Buffer.from(c.medicareIdHash)] : [],
    );
  }
  return matcher;
}

/** All the org's agents by email, or — with `email` — just that one (single-row lookup). */
export async function loadAgentsByEmail(orgId: string, exec: Executor = db, email?: string): Promise<Map<string, string>> {
  const agents = await exec.select({ id: agentsTable.id, email: agentsTable.email }).from(agentsTable)
    .where(email
      ? and(eq(agentsTable.orgId, orgId), sql`lower(${agentsTable.email}) = ${email.toLowerCase()}`)
      : eq(agentsTable.orgId, orgId));
  return new Map(agents.filter((a) => a.email).map((a) => [a.email.toLowerCase(), a.id]));
}

export async function loadCarriersByName(orgId: string): Promise<Map<string, string>> {
  const carriers = await db.select({ id: carriersTable.id, name: carriersTable.name }).from(carriersTable)
    .where(eq(carriersTable.orgId, orgId));
  return new Map(carriers.map((c) => [carrierKey(c.name), c.id]));
}

/** NFKC folds lookalikes (e.g. NBSP → space); JS \s and toLowerCase are Unicode-aware. */
function carrierKey(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Validate (preview) ──────────────────────────────────────────────────────

export interface ContactValidationSummary {
  issues: CsvIssue[];
  validRows: number;
  duplicateCount: number;
  enrollmentCount: number;
  newCarriers: string[];
}

export async function previewContactImport(
  orgId: string,
  rows: Record<string, string>[],
  rowNumbers: number[],
  mapping: Record<string, string>,
  duplicateAction: DuplicateAction,
): Promise<ContactValidationSummary> {
  const interpreted = rows.map((r, i) => interpretContactRow(r, mapping, rowNumbers[i] ?? i + 2));
  const contacts = interpreted.map((r) => r.contact).filter((c): c is InterpretedContact => !!c);
  const [matcher, agentsByEmail, carriersByName] = await Promise.all([
    loadMatcher(orgId, contacts),
    loadAgentsByEmail(orgId),
    loadCarriersByName(orgId),
  ]);

  const issues: CsvIssue[] = [];
  const newCarriers = new Map<string, string>();
  let validRows = 0;
  let duplicateCount = 0;
  let enrollmentCount = 0;

  for (const r of interpreted) {
    issues.push(...r.issues);
    if (!r.contact) continue;
    validRows++;
    const c = r.contact;
    if (c.assignedAgentEmail && !agentsByEmail.has(c.assignedAgentEmail)) {
      issues.push({ row: r.row, field: "assignedAgentEmail", severity: "warning", message: "No agent in agencyBRIDGE has that email — contact will be unassigned" });
    }
    if (r.enrollment) {
      enrollmentCount++;
      const name = r.enrollment.carrierName;
      if (name && !carriersByName.has(carrierKey(name)) && !newCarriers.has(carrierKey(name))) newCarriers.set(carrierKey(name), name);
    }
    const hit = matcher.find(c);
    if (hit) {
      duplicateCount++;
      const who = hit.match.fromRow ? `row ${hit.match.fromRow} of this file` : "an existing contact";
      const outcome = duplicateAction === "skip" ? "row will be skipped"
        : duplicateAction === "create_new" ? "a separate contact will still be created"
        : "blank fields will be filled in and coverage added";
      issues.push({ row: r.row, field: "duplicate", severity: "warning", message: `Same person as ${who} (matched on ${hit.reason}) — ${outcome}` });
    } else {
      matcher.add(known(`row-${r.row}`, c, r.row), c.mbi ? mbiHashesFor(c.mbi) : []);
      if (!hasMatchKey(c)) {
        issues.push({ row: r.row, field: "duplicate", severity: "warning", message: "No Medicare ID, email, phone, or date of birth — can't check whether this person already exists" });
      }
    }
  }

  for (const name of newCarriers.values()) {
    issues.push({ row: 0, field: "carrier", severity: "warning", message: `Carrier "${name}" is not set up yet — it will be added` });
  }

  return { issues, validRows, duplicateCount, enrollmentCount, newCarriers: [...newCarriers.values()] };
}

// ─── Confirm: prepare rows for the queue ─────────────────────────────────────

/**
 * Tag each row with its file line number and encrypt the Medicare ID cell
 * before the rows are persisted to `import_jobs.options` (jsonb) for the
 * worker. The plaintext MBI must never sit in that column.
 */
export function prepareRowsForQueue(
  rows: Record<string, string>[],
  rowNumbers: number[],
  mapping: Record<string, string>,
): Record<string, string>[] {
  const mbiCols = Object.keys(mapping).filter((k) => mapping[k] === "medicareId");
  return rows.map((row, i) => {
    const out: Record<string, string> = { ...row, [ROW_NUMBER_KEY]: String(rowNumbers[i] ?? i + 2) };
    for (const col of mbiCols) {
      const v = (out[col] ?? "").trim();
      if (v) out[col] = ENCRYPTED_CELL_PREFIX + encryptMedicareId(v).encrypted.toString("base64");
    }
    return out;
  });
}

// ─── Worker: write contacts + enrollments ────────────────────────────────────

type ImportError = { row: number; field?: string; message: string };

export async function processCsvContactImport(
  jobId: string,
  orgId: string,
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  duplicateAction: DuplicateAction = "merge",
): Promise<void> {
  // Seed with the rows the confirm step could not parse, so they stay in the
  // job's report. Read from options (written once at confirm), never from
  // job.errors: a retried attempt would otherwise re-append its own output.
  const [job] = await db.select({ options: importJobsTable.options })
    .from(importJobsTable).where(eq(importJobsTable.id, jobId)).limit(1);
  // Every job write below applies only while the job is still `processing`:
  // if cleanup declared it dead, this run must not resurrect it.
  const stillMine = and(eq(importJobsTable.id, jobId), eq(importJobsTable.status, "processing"));
  const beat = await db.update(importJobsTable).set({ heartbeatAt: new Date() }).where(stillMine).returning({ id: importJobsTable.id });
  if (beat.length === 0) {
    logger.warn({ jobId }, "imports: job is no longer processing; not starting");
    return;
  }
  let lastBeat = Date.now();
  const parseIssues = ((job?.options as { parseIssues?: CsvIssue[] } | null)?.parseIssues) ?? [];
  let created = 0, updated = 0, skipped = 0;
  let errors = parseIssues.filter((p) => p.severity === "error").length;
  let warnings = parseIssues.length - errors;
  const errorList: ImportError[] = parseIssues.map((p) => ({ row: p.row, field: p.field, message: p.message }));

  const interpreted = rows.map((r, i) => interpretContactRow(r, mapping, Number(r[ROW_NUMBER_KEY]) || i + 2));
  const [matcher, agentsByEmail, carriersByName] = await Promise.all([
    loadMatcher(orgId, interpreted.map((r) => r.contact).filter((c): c is InterpretedContact => !!c)),
    loadAgentsByEmail(orgId),
    loadCarriersByName(orgId),
  ]);

  for (let i = 0; i < interpreted.length; i++) {
    const r = interpreted[i]!;
    for (const issue of r.issues) {
      errorList.push({ row: issue.row, field: issue.field, message: issue.message });
      if (issue.severity === "warning") warnings++;
    }
    if (!r.contact) { errors++; continue; }
    const c = r.contact;
    const newCarrierKeys: string[] = [];

    try {
      // Row warnings are reported only once the row's transaction commits; a
      // rolled-back row reports just its failure, never a stale warning.
      const rowWarnings: ImportError[] = [];
      const agentId = c.assignedAgentEmail ? agentsByEmail.get(c.assignedAgentEmail) ?? null : null;
      if (c.assignedAgentEmail && !agentId) {
        rowWarnings.push({ row: r.row, field: "assignedAgentEmail", message: "No agent in agencyBRIDGE has that email — left unassigned" });
      }
      const hit = duplicateAction === "create_new" ? null : matcher.find(c);
      if (hit && duplicateAction === "skip") {
        // Nothing is written for a skipped row, but the agent-column warning is
        // still true and tells the admin their mapping is off.
        errorList.push(...rowWarnings);
        warnings += rowWarnings.length;
        skipped++;
        continue;
      }

      const contactId = await db.transaction(async (tx) => {
        const carrierId = r.enrollment?.carrierName
          ? await resolveCarrier(tx, orgId, r.enrollment.carrierName, carriersByName, newCarrierKeys)
          : null;
        let id: string;
        if (hit) {
          id = hit.match.id;
          for (const w of await fillBlanks(tx, orgId, id, c, agentId)) {
            rowWarnings.push({ row: r.row, field: w.field, message: w.message });
          }
        } else {
          id = await insertContact(tx, orgId, c, agentId, r.enrollment ? "enrolled" : "lead");
        }

        if (r.enrollment) {
          const e = r.enrollment;
          const today = new Date().toISOString().slice(0, 10);
          await tx.insert(enrollmentsTable).values({
            id: randomUUID(),
            orgId,
            contactId: id,
            carrierId,
            agentId,
            planName: e.planName,
            planType: e.planType,
            planYear: e.planYear,
            effectiveDate: e.effectiveDate,
            // A book-of-business row describes coverage that exists; only a
            // future effective date is still pending. `effectuated` stays
            // false until a carrier statement confirms it.
            status: e.effectiveDate <= today ? "active" : "pending",
            notes: "Imported from CSV",
          }).onConflictDoUpdate({
            target: [enrollmentsTable.contactId, enrollmentsTable.planYear, enrollmentsTable.planType, enrollmentsTable.carrierId],
            set: {
              planName: sql`coalesce(${enrollmentsTable.planName}, excluded.plan_name)`,
              agentId: sql`coalesce(${enrollmentsTable.agentId}, excluded.agent_id)`,
            },
          });
          await syncContactCoverageProjection(id, orgId, tx);
        }
        return id;
      });

      errorList.push(...rowWarnings);
      warnings += rowWarnings.length;
      if (hit) updated++;
      else {
        created++;
        matcher.add(known(contactId, c, r.row), c.mbi ? mbiHashesFor(c.mbi) : []);
      }
    } catch (err) {
      // The transaction rolled back, including any carrier it created.
      for (const k of newCarrierKeys) carriersByName.delete(k);
      errors++;
      errorList.push({ row: r.row, message: "Failed to save contact" });
      logger.error({ err, jobId, row: r.row }, "imports: failed to import CSV contact row");
      captureWorkerError(err, { worker: "imports", route: "contacts/confirm", jobId, row: r.row });
    }

    // Every 50 rows, and at least once a minute so a small but slow import
    // never looks dead to the cleanup sweep.
    if (i % 50 === 0 || Date.now() - lastBeat > 60_000) {
      lastBeat = Date.now();
      const alive = await db.update(importJobsTable)
        .set({ processedRows: i + 1, errorCount: errors, errors: errorList, heartbeatAt: new Date() })
        .where(stillMine).returning({ id: importJobsTable.id });
      if (alive.length === 0) {
        logger.warn({ jobId, processedRows: i + 1 }, "imports: job was failed by cleanup; stopping");
        return;
      }
    }
  }

  const done = await db.update(importJobsTable).set({
    status: "completed",
    processedRows: rows.length,
    createdCount: created,
    updatedCount: updated,
    skippedCount: skipped,
    errorCount: errors,
    warningCount: warnings,
    errors: errorList,
    // Drop the queued rows: they hold PHI (names, DOBs, addresses) and are
    // not needed once the job is done. The error list is kept for download.
    options: { mapping, duplicateAction, rowsPurged: true },
    completedAt: new Date(),
  }).where(stillMine).returning({ id: importJobsTable.id });
  if (done.length === 0) logger.warn({ jobId }, "imports: job was failed by cleanup before it finished; left as failed");
}


export async function insertContact(
  tx: Tx,
  orgId: string,
  c: InterpretedContact,
  agentId: string | null,
  status: "lead" | "enrolled",
): Promise<string> {
  const id = randomUUID();
  const enc = c.mbi ? encryptMedicareId(c.mbi) : null;
  await tx.insert(contactsTable).values({
    id,
    orgId,
    assignedAgentId: agentId,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    dob: c.dob ? new Date(`${c.dob}T00:00:00Z`) : null,
    address1: c.address1,
    city: c.city,
    county: c.county,
    stateCode: c.stateCode,
    zipCode: c.zipCode,
    leadSource: c.leadSource,
    tags: c.tags.length > 0 ? c.tags : null,
    medicareIdEncrypted: enc?.encrypted ?? null,
    medicareIdHash: enc?.hash ?? null,
    optOutSms: c.optOut,
    optOutEmail: c.optOut,
    status,
  });
  return id;
}

/**
 * Create-or-merge one contact arriving from an integration (webhook or feed),
 * with the same duplicate rules and fill-blanks-only merge as the CSV import.
 */
export async function upsertContact(
  tx: Tx,
  orgId: string,
  c: InterpretedContact,
  agentId: string | null,
): Promise<{ contactId: string; created: boolean; matchedOn: string | null; warnings: { field: string; message: string }[] }> {
  // Serialize match-then-insert per org: without it, two deliveries for the
  // same new person can both see "no match" and each create a contact.
  // 64-bit key (hashtextextended) so unrelated orgs never collide on the lock.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`contact-upsert:${orgId}`}, 0))`);
  const matcher = await loadMatcher(orgId, [c], tx);
  const hit = matcher.find(c);
  if (hit) {
    const warnings = await fillBlanks(tx, orgId, hit.match.id, c, agentId);
    return { contactId: hit.match.id, created: false, matchedOn: hit.reason, warnings };
  }
  return { contactId: await insertContact(tx, orgId, c, agentId, "lead"), created: true, matchedOn: null, warnings: [] };
}

export async function fillBlanks(
  tx: Tx,
  orgId: string,
  id: string,
  c: InterpretedContact,
  agentId: string | null,
): Promise<{ field: string; message: string }[]> {
  const warnings: { field: string; message: string }[] = [];
  const [cur] = await tx.select().from(contactsTable).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, orgId))).limit(1);
  if (!cur) return warnings;
  const patch: Partial<typeof contactsTable.$inferInsert> = {};
  if (!cur.email && c.email) patch.email = c.email;
  if (!cur.phone && c.phone) patch.phone = c.phone;
  if (!cur.dob && c.dob) patch.dob = new Date(`${c.dob}T00:00:00Z`);
  if (!cur.address1 && c.address1) patch.address1 = c.address1;
  if (!cur.city && c.city) patch.city = c.city;
  if (!cur.county && c.county) patch.county = c.county;
  if (!cur.stateCode && c.stateCode) patch.stateCode = c.stateCode;
  if (!cur.zipCode && c.zipCode) patch.zipCode = c.zipCode;
  if (!cur.leadSource && c.leadSource) patch.leadSource = c.leadSource;
  if (!cur.assignedAgentId && agentId) patch.assignedAgentId = agentId;
  if (!cur.medicareIdEncrypted && c.mbi) {
    const enc = encryptMedicareId(c.mbi);
    patch.medicareIdEncrypted = enc.encrypted;
    patch.medicareIdHash = enc.hash;
  } else if (cur.medicareIdHash && c.mbi) {
    const onFile = Buffer.from(cur.medicareIdHash);
    if (!mbiHashesFor(c.mbi).some((h) => h.equals(onFile))) {
      // Surface the conflict; never silently overwrite an identifier.
      warnings.push({ field: "medicareId", message: "Medicare ID on file differs from the imported one — imported value not applied. Please review this contact." });
    }
  }
  if (c.tags.length > 0) {
    const merged = [...new Set([...(cur.tags ?? []), ...c.tags])];
    if (merged.length !== (cur.tags ?? []).length) patch.tags = merged;
  }
  if (Object.keys(patch).length > 0) {
    await tx.update(contactsTable).set(patch).where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, orgId)));
  }
  return warnings;
}

/**
 * Find the org's carrier by case/space-insensitive name, creating it if absent.
 * Runs inside the row's transaction, so a failed row leaves no orphan carrier.
 *
 * No unique index backs this: existing orgs may already hold same-named
 * carriers, and adding one would make the migration fail on their data.
 * Instead, a per-org transaction advisory lock serializes the
 * re-check-then-insert, so concurrent imports (the CSV worker runs two at a
 * time per instance, across instances) cannot both create the same carrier.
 */
async function resolveCarrier(
  tx: Tx,
  orgId: string,
  name: string,
  cache: Map<string, string>,
  created: string[],
): Promise<string> {
  const key = carrierKey(name);
  const cached = cache.get(key);
  if (cached) return cached;
  // Keyed per carrier: rows naming different new carriers don't wait on each
  // other; two rows racing to create the same one still serialize.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`carrier-create:${orgId}:${key}`}, 0))`);
  // Compare in JS with the same normalization as the cache. SQL lower() and
  // POSIX classes are locale/ASCII-bound and disagree with JS on NBSP and
  // accented letters. An org's carrier list is small.
  const rows = await tx.select({ id: carriersTable.id, name: carriersTable.name }).from(carriersTable)
    .where(eq(carriersTable.orgId, orgId));
  const existing = rows.find((r) => carrierKey(r.name) === key);
  const id = existing?.id ?? randomUUID();
  if (!existing) {
    await tx.insert(carriersTable).values({ id, orgId, name: name.trim().replace(/\s+/g, " ") });
    created.push(key);
  }
  cache.set(key, id);
  return id;
}
