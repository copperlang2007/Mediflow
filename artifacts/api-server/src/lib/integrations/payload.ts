/**
 * Turn an arbitrary vendor JSON payload into the flat field set the contact
 * importer understands.
 *
 * Vendors (EnrollHere, GHL workflows, Zapier) nest the person under different
 * keys (`contact`, `lead`, `client`, `data.contact`…) and spell fields
 * differently (`first_name`, `firstName`, `FirstName`). Rather than a
 * per-vendor mapper that breaks on the next field rename, we flatten the
 * likely containers and reuse the CSV importer's header recognizer
 * (`suggestContactField`) plus its row interpreter, so a webhook and a CSV
 * row with the same fields produce the same contact.
 */
import { interpretContactRow, suggestContactField, type InterpretedRow } from "../contactImport";

type Json = unknown;

const PERSON_CONTAINERS = ["contact", "lead", "client", "customer", "beneficiary", "member", "person", "caller", "prospect"];

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `callId` / `Call ID` / `call-id` → `call_id`. */
export function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function scalar(v: Json): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Leaves of an `address` block that name a specific contact field. */
const ADDRESS_PARTS: Record<string, string> = {
  street: "address1", street1: "address1", street_1: "address1", line1: "address1", line_1: "address1",
  address: "address1", address1: "address1", address_1: "address1", address_line_1: "address1",
  city: "city", town: "city", county: "county",
  state: "state", state_code: "state", region: "state",
  zip: "zip", zip_code: "zip", zipcode: "zip", postal_code: "zip", postcode: "zip",
};

/**
 * Flatten one object's scalar leaves into `out` (first value wins). Nested
 * objects contribute `${parent}_${leaf}` keys, so `agent.email` becomes
 * `agent_email`. Inside an address block, known parts are emitted under
 * their plain field name ONLY (`address.city` → `city`, `address.street` →
 * `address1`): a prefixed `address_city` would be read as a street address.
 */
function flattenInto(out: Record<string, string>, obj: Record<string, Json>, prefix = "", depth = 0): void {
  const inAddress = /(^|_)(address|mailing_address|home_address|residential_address)$/.test(prefix);
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = normalizeKey(rawKey);
    const full = prefix ? `${prefix}_${key}` : key;
    const s = scalar(value);
    if (s !== null) {
      const part = inAddress ? ADDRESS_PARTS[key] : undefined;
      if (part) {
        if (!(part in out)) out[part] = s;
      } else if (!(full in out)) {
        out[full] = s;
      }
    } else if (isObject(value) && depth < 2) {
      flattenInto(out, value, full, depth + 1);
    }
  }
}

/**
 * Flattened view of a payload.
 *
 *  - `person-first` (for contact fields): the person container's fields win,
 *    so `contact.email` beats a top-level `email` about the sender.
 *  - `event-first` (for call/event metadata): top-level and `data` fields
 *    win, so the event's own `id`/`type` is never shadowed by `contact.id`.
 */
export function flattenPayload(payload: Json, order: "person-first" | "event-first" = "person-first"): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(payload)) return out;
  const roots: Record<string, Json>[] = [payload];
  if (isObject(payload.data)) roots.push(payload.data);
  const containers = () => {
    for (const root of roots) {
      for (const name of PERSON_CONTAINERS) {
        const c = Object.entries(root).find(([k]) => normalizeKey(k) === name)?.[1];
        if (isObject(c)) flattenInto(out, c);
      }
    }
  };
  const tops = () => { for (const root of roots) flattenInto(out, root); };
  if (order === "event-first") { tops(); containers(); } else { containers(); tops(); }
  return out;
}

/**
 * JSON with object keys sorted at every level, so two encodings of the same
 * payload (key order, whitespace) produce the same string — used for the
 * idempotency hash when the sender supplies no event id.
 */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Every key path seen in the payload (names only — never values). */
export function payloadKeyPaths(payload: Json, prefix = "", depth = 0): string[] {
  if (!isObject(payload) || depth > 3) return [];
  return Object.entries(payload).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isObject(v) ? [path, ...payloadKeyPaths(v, path, depth + 1)] : [path];
  });
}

/** Return the first non-empty value among the given normalized keys. */
export function pick(flat: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = flat[k];
    if (v) return v;
  }
  return null;
}

/**
 * Interpret the person in a flattened payload exactly as the CSV importer
 * would interpret a row with those column headers.
 */
export function interpretPayloadContact(flat: Record<string, string>): InterpretedRow {
  const mapping: Record<string, string> = {};
  const taken = new Set<string>();
  for (const key of Object.keys(flat)) {
    const field = suggestContactField(key);
    if (field && !taken.has(field)) {
      mapping[key] = field;
      taken.add(field);
    }
  }
  return interpretContactRow(flat, mapping, 0);
}
