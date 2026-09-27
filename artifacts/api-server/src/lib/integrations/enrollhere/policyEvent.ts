/**
 * EnrollHere policy events (`PE_POLICY_CREATED`, `PE_POLICY_UPDATED`, …).
 *
 * Unlike call events, these have a known shape (captured from a real
 * delivery): everything lives under `policy`, the beneficiary under
 * `policy.enrollment.consumer` (fallback `policy.lead`), and the plan under
 * `policy.enrollment.plan`. Dates are objects (`{ date, timestamp, … }`).
 *
 * The parser reads only what agencyBRIDGE promotes to plain columns: the
 * person's contact details, plan / carrier / dates / status, and the agent.
 * It deliberately never reads the health answers (`medicareInfo.chf`,
 * `copd`, `cvd`, `diabetes`, …) or any race/ethnicity field: those stay only
 * inside the encrypted application payload and must never feed routing,
 * scoring or AI.
 */
import { canonicalMbi, normalizePlanType, parseFlexibleDate, type PlanType } from "../../csvImport";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};
const at = (o: unknown, ...path: string[]): unknown => {
  let cur: unknown = o;
  for (const p of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
};

/** `{ date: "2026-01-01T12:00:00.000Z", … }` or a plain string → `yyyy-mm-dd`. */
export function policyDate(v: unknown): string | null {
  const raw = isObj(v) ? str(v.date) : str(v);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1]! : parseFlexibleDate(raw, "past");
}

function policyInstant(v: unknown): Date | null {
  const raw = isObj(v) ? str(v.date) : str(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isPolicyEvent(body: unknown): boolean {
  return isObj(body) && typeof body.event === "string" && /^PE_/.test(body.event) && isObj(body.policy);
}

export type EnrollmentStatus = "pending" | "active" | "terminated" | "cancelled" | "declined";

/** EnrollHere policy status (`POL_INFORCE`, `POL_SUBMITTED`, …) → our enrollment status. */
export function mapPolicyStatus(raw: string | null): { status: EnrollmentStatus; effectuated: boolean } {
  const s = (raw ?? "").toUpperCase();
  if (/INFORCE|IN_FORCE|ACTIVE|EFFECTUATED/.test(s)) return { status: "active", effectuated: true };
  if (/CANCEL|WITHDRAW|RESCIND/.test(s)) return { status: "cancelled", effectuated: false };
  if (/TERMINAT|DISENROLL|LAPSE/.test(s)) return { status: "terminated", effectuated: false };
  if (/DECLIN|REJECT|DENIED|DENY/.test(s)) return { status: "declined", effectuated: false };
  return { status: "pending", effectuated: false };
}

export interface ParsedPolicyEvent {
  eventType: string;
  policyId: string | null;
  /** Sunfire confirmation code, when EnrollHere carries one. */
  confirmationCode: string | null;
  policyNumber: string | null;
  /** Flat, CSV-style fields for the shared contact interpreter. */
  contactFlat: Record<string, string>;
  agentEmail: string | null;
  agentNpn: string | null;
  carrierName: string | null;
  planId: string | null;
  planName: string | null;
  planType: PlanType | null;
  planTypeRaw: string | null;
  snpType: string | null;
  policyStatus: string | null;
  effectiveDate: string | null;
  signatureDate: string | null;
  submittedAt: Date | null;
  medicareNumber: string | null;
  medicaidNumber: string | null;
  /** The payload as stored (encrypted): the body minus any relay wrapper. */
  storedPayload: Obj;
}

function firstId(o: unknown, ...path: string[]): string | null {
  const ids = at(o, ...path);
  return Array.isArray(ids) ? str(ids[0]) : null;
}

export function parsePolicyEvent(body: Obj): ParsedPolicyEvent {
  const policy = body.policy as Obj;
  const enrollment = isObj(policy.enrollment) ? policy.enrollment : {};
  const person = isObj(enrollment.consumer) ? enrollment.consumer : isObj(policy.lead) ? policy.lead : {};
  const address = isObj(person.address) ? person.address : {};
  const plan = isObj(enrollment.plan) ? enrollment.plan : {};
  const details = isObj(enrollment.details) ? enrollment.details : {};
  const agent = isObj(policy.agent) ? policy.agent : isObj(enrollment.agent) ? enrollment.agent : {};

  const confirmationCode = firstId(enrollment, "identifiers", "bySource", "sunfire", "ids")
    ?? firstId(policy, "identifiers", "bySource", "sunfire", "ids");
  const policyNumber = firstId(policy, "identifiers", "bySource", "policyId", "ids")
    ?? firstId(enrollment, "identifiers", "bySource", "policyId", "ids");

  const medicareRaw = str(at(person, "medicare", "number")) ?? str(at(enrollment, "medicareInfo", "number"));
  const medicareNumber = medicareRaw ? canonicalMbi(medicareRaw) : null;
  const medicaidNumber = str(at(enrollment, "medicaidInfo", "number")) ?? str(at(enrollment, "medicaidInfo", "id"))
    ?? str(at(person, "medicaid", "number"));

  const contactFlat: Record<string, string> = {};
  const put = (k: string, v: string | null) => { if (v) contactFlat[k] = v; };
  put("first_name", str(person.firstName));
  put("last_name", str(person.lastName));
  put("email", str(person.email));
  put("phone", str(person.phone));
  put("address1", str(address.line1));
  put("city", str(address.city));
  put("state", str(address.state));
  put("zip", str(address.zip));
  put("county", str(address.county));
  put("dob", policyDate(person.birthDate));
  if (medicareNumber) put("medicare_id", medicareNumber);
  put("assigned_agent_email", str(agent.email));

  const planTypeRaw = str(plan.planType);
  const policyStatus = str(policy.manualStatus) ?? str(policy.automaticStatus) ?? str(details.policyStatus);

  // Drop a relay's wrapper (GoHighLevel adds the request `headers`): it holds
  // IPs and trace ids, not application data.
  const { headers: _relayHeaders, ...storedPayload } = body;

  return {
    eventType: String(body.event),
    policyId: str(policy.id),
    confirmationCode,
    policyNumber,
    contactFlat,
    agentEmail: str(agent.email)?.toLowerCase() ?? null,
    agentNpn: str(agent.npn),
    carrierName: str(at(enrollment, "carrier", "name")),
    planId: str(plan.id),
    planName: str(plan.name),
    planType: planTypeRaw ? normalizePlanType(planTypeRaw.replace(/^PT_/i, "")) : null,
    planTypeRaw,
    snpType: str(plan.snp),
    policyStatus,
    effectiveDate: policyDate(details.effectiveDate) ?? policyDate(policy.effectiveDate),
    signatureDate: policyDate(details.signatureDate),
    submittedAt: policyInstant(policy.submittedAt),
    medicareNumber,
    medicaidNumber,
    storedPayload,
  };
}
