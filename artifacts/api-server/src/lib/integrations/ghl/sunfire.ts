/**
 * Sunfire enrollment data carried in GoHighLevel custom fields.
 *
 * INSUREitALL's Sunfire enrollments are written onto their Odyssey (GHL)
 * contacts as ~300 custom fields. This module turns one contact's custom
 * field values into the same `ParsedPolicyEvent` the EnrollHere receiver
 * builds, so both sources share one write path (enrollment row + encrypted,
 * versioned application record) and land on the same policy.
 *
 * What goes where:
 *   - plain columns: carrier, plan, plan type/year, dates, status, agent NPN;
 *   - encrypted columns: Medicare and Medicaid numbers;
 *   - the encrypted application payload: every other application field,
 *     including health answers, race/ethnicity and POA/LTC details, shown
 *     only in the audited full-application view;
 *   - the contact: Medicare ID, date of birth, county, language, PCP and a
 *     short list of qualifying health conditions (for C-SNP / D-SNP / I-SNP
 *     eligibility), all fill-blanks only.
 *
 * Never read or stored: Social Security numbers, bank account and card
 * details, and the agent's own SSN / TIN.
 */
import { canonicalMbi, normalizePlanType, parseFlexibleDate } from "../../csvImport";
import type { ParsedPolicyEvent } from "../enrollhere/policyEvent";
import type { GhlContact } from "./client";

/** Custom field id → definition (from listContactCustomFields). */
export type FieldDefs = Map<string, { name: string; key: string }>;

/**
 * Field keys never read, stored or logged: SSNs, TINs, bank and card data.
 * Matched on the merge key without its `contact.` prefix.
 */
const NEVER_STORED = /(^|_)(ssn|tin)$|social_security|bank_account|routing_number|credit_card|card_number|cvv/;

export function isNeverStored(key: string): boolean {
  return NEVER_STORED.test(key.toLowerCase());
}

/** A custom field value as text; lists are joined, objects ignored. */
function asText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    const parts = v.map(asText).filter((s): s is string => !!s);
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

/**
 * The contact's custom field values keyed by merge key (`medicare_number`,
 * not `contact.medicare_number`), with the never-stored fields removed.
 */
export function customValues(gc: GhlContact, defs: FieldDefs): Map<string, { name: string; value: string }> {
  const out = new Map<string, { name: string; value: string }>();
  for (const f of gc.customFields ?? []) {
    const def = f && typeof f.id === "string" ? defs.get(f.id) : undefined;
    if (!def) continue;
    // GHL merge keys are `contact.<key>`; strip any object prefix so a field
    // under another prefix still matches the keys read below.
    const key = def.key.replace(/^[a-z_]+\./i, "");
    if (isNeverStored(key)) continue;
    const value = asText(f.value);
    if (value) out.set(key, { name: def.name, value });
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date from separate year / month / day fields (month may be a name). */
function dateFromParts(year: string | null, month: string | null, day: string | null): string | null {
  if (!year || !month) return null;
  const monthIdx = MONTHS.indexOf(month.trim().slice(0, 3).toLowerCase());
  const m = monthIdx >= 0 ? monthIdx + 1 : Number(month);
  const y = Number(year);
  const d = day ? Number(day) : 1;
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return parseFlexibleDate(`${y}-${m}-${d}`);
}

const YES = /^(y|yes|true|1|x|checked)$/i;

/**
 * Health answers that open plan doors (C-SNP, D-SNP, I-SNP, ESRD), as short
 * labels for the contact's health conditions. Only "yes" answers count.
 */
const QUALIFYING_CONDITIONS: Array<[key: string | RegExp, label: string]> = [
  ["has_copd", "COPD"],
  ["has_chf", "Congestive heart failure (CHF)"],
  ["has_cvd", "Cardiovascular disease"],
  ["has_cardiovascular_disorder", "Cardiovascular disorder"],
  ["has_diabetes", "Diabetes"],
  ["has_esrd", "End-stage renal disease (ESRD)"],
  ["requires_regular_dialysis", "Requires regular dialysis"],
  ["had_successful_transplant", "Organ transplant"],
  ["is_in_longterm_care_facility", "Lives in a long-term care facility"],
  ["reside_in_skilled_nursing", "Lives in skilled nursing"],
  [/^have_you_ever_been_diagnosed_with_or_treated_for_any_lung_conditions/, "Lung condition (COPD, emphysema, bronchitis or pulmonary hypertension)"],
  [/^have_you_ever_been_diagnosed_with_or_treated_for_any_heart_or_circulatory/, "Heart or circulatory condition"],
  [/^have_you_ever_been_diagnosed_with_or_treated_for_cancer/, "Cancer history"],
  [/^have_you_been_diagnosed_with_diabetes_that_has_caused_complications/, "Diabetes with complications"],
];

export function qualifyingConditions(values: Map<string, { value: string }>): string[] {
  const out: string[] = [];
  for (const [match, label] of QUALIFYING_CONDITIONS) {
    for (const [key, { value }] of values) {
      const hit = typeof match === "string" ? key === match : match.test(key);
      if (hit && YES.test(value.trim())) {
        out.push(label);
        break;
      }
    }
  }
  return out;
}

/** Plan type from Sunfire's field, else inferred from the CMS contract prefix. */
function planTypeFrom(raw: string | null, contractId: string | null, planName: string | null) {
  const direct = raw ? normalizePlanType(raw) : null;
  if (direct) return direct;
  const prefix = contractId?.trim().charAt(0).toUpperCase();
  if (prefix === "S") return "PDP" as const;
  if (prefix === "H" || prefix === "R") {
    return planName && /\b(PD|MAPD|Rx)\b/i.test(planName) ? "MAPD" as const : "MA" as const;
  }
  return null;
}

export interface SunfireApplication {
  parsed: ParsedPolicyEvent;
  /** Contact fields for the shared interpreter (Medicare ID, DOB, county…). */
  contactFlat: Record<string, string>;
  pcpName: string | null;
  preferredLanguage: string | null;
  healthConditions: string[];
  /**
   * Application key when Sunfire sent no confirmation code: this GHL contact's
   * plan + effective date, so a later enrollment (next AEP, written over the
   * same fields) starts its own record instead of rewriting this one.
   */
  fallbackKey: string;
}

/**
 * Read the Sunfire application on a GHL contact. Null when the contact carries
 * no application (no confirmation code and no plan): an ordinary lead.
 */
export function readSunfireApplication(gc: GhlContact, defs: FieldDefs): SunfireApplication | null {
  const values = customValues(gc, defs);
  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = values.get(k)?.value;
      if (v) return v;
    }
    return null;
  };

  const confirmationCode = get("confirmation_code", "confirmationnumber", "sunfire_enrollment_id", "telephonic_enrollment_confirmation_code");
  const carrierName = get("carrier_name", "carriername", "carrier", "alt_carrier_name");
  const planName = get("plan_name", "planname", "new_plan_name", "display_name", "plan_brand_name", "brand_name");
  const contractId = get("cms_contract_id", "contract_id", "contractid");
  const cmsPlan = get("cms_plan_id");
  const segment = get("cms_segment_id", "segment_id");
  const planId = contractId && cmsPlan
    ? [contractId, cmsPlan.padStart(3, "0"), (segment ?? "0").padStart(3, "0")].join("-")
    : get("plan_id", "planid", "sunfire_plan_id");
  if (!confirmationCode && !planName && !planId) return null;

  const planTypeRaw = get("plan_type", "plan_policy_type");
  const planType = planTypeFrom(planTypeRaw, contractId, planName);
  const effectiveDate = parseFlexibleDate(get("effective_date") ?? "")
    ?? dateFromParts(get("plan_effective_date_year"), get("plan_effective_date_month"), get("plan_effective_date_day"))
    ?? parseFlexibleDate(get("start_date_for_the_enrollment") ?? "");
  const signatureDate = parseFlexibleDate(get("signature_date") ?? "")
    ?? dateFromParts(get("signature_date_year"), get("signature_date_month"), get("signature_date_day"))
    ?? parseFlexibleDate(get("app_submit_date") ?? "");
  const submittedRaw = get("app_submit_date", "submittime");
  const submitted = submittedRaw ? new Date(submittedRaw) : null;

  const medicareRaw = get("medicare_number", "applicanthicn");
  const medicareNumber = medicareRaw ? canonicalMbi(medicareRaw) : null;
  const medicaidNumber = get("medicaid_number");
  const dob = parseFlexibleDate(get("dob") ?? "", "past")
    ?? dateFromParts(get("dob_year"), get("dob_month"), get("dob_day"));

  const contactFlat: Record<string, string> = {};
  if (medicareNumber) contactFlat.medicare_id = medicareNumber;
  if (dob) contactFlat.dob = dob;
  const county = get("county");
  if (county) contactFlat.county = county;

  // The encrypted record keeps every application field by its GHL label.
  const fields: Record<string, string> = {};
  for (const [key, { name, value }] of values) fields[`${name} (${key})`] = value;

  const parsed: ParsedPolicyEvent = {
    eventType: "GHL_SUNFIRE_APPLICATION",
    policyId: null,
    confirmationCode,
    policyNumber: null,
    contactFlat,
    agentEmail: get("agent_email_address", "agentemail")?.toLowerCase() ?? null,
    agentNpn: get("agent_npn", "agent_broker_npn"),
    carrierName,
    planId,
    planName,
    planType,
    planTypeRaw: planTypeRaw ?? (planType ? `inferred:${planType}` : null),
    snpType: get("snp"),
    // "In Force" / "in-force" → IN_FORCE, the form mapPolicyStatus reads.
    policyStatus: get("confirmation_status")?.toUpperCase().replace(/[\s-]+/g, "_") ?? null,
    effectiveDate,
    signatureDate,
    submittedAt: submitted && !Number.isNaN(submitted.getTime()) ? submitted : null,
    medicareNumber,
    medicaidNumber,
    identifiersPresent: !!(medicareNumber || medicaidNumber),
    storedPayload: { source: "gohighlevel", ghlContactId: gc.id, fields },
  };

  return {
    parsed,
    contactFlat,
    pcpName: get("pcp_name", "primarycarephysician"),
    preferredLanguage: get("language"),
    healthConditions: qualifyingConditions(values),
    fallbackKey: `ghl:${gc.id}:${planId ?? planName ?? ""}:${effectiveDate ?? ""}`,
  };
}
