/**
 * Client hooks for the Client Portal preview, Softphone, Supervisor and
 * Quoting pages (stage2/portal-dialer).
 *
 * The endpoints are hand-rolled (not in the generated OpenAPI client), so —
 * like lib/queue/api.ts and lib/crm/callSummaries.ts — these wrap `apiFetch`
 * in react-query directly.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---- Roles (UX only — the API enforces the real gate) ----------------------

/** Roles the API grants `contact:read` (lib/permissions.ts). */
export const CONTACT_READ_ROLES = [
  "super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer",
] as const;
/** Roles the API grants `contact:update` (needed to log a call / reply). */
export const CONTACT_UPDATE_ROLES = [
  "super_admin", "agency_admin", "compliance_manager", "agent_support",
] as const;
/** Supervisor tier — `agent:admin`. */
export const SUPERVISOR_ROLES = ["super_admin", "agency_admin"] as const;

// ---- Contacts --------------------------------------------------------------

export interface ContactLite {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  stateCode: string | null;
  zipCode: string | null;
  currentPlanType: string | null;
  assignedAgentId?: string | null;
}

/** Name / email / phone search over the existing `GET /contacts`. */
export function useContactSearch(search: string, enabled = true) {
  const q = search.trim();
  return useQuery({
    queryKey: ["/api/contacts", "picker", q],
    queryFn: ({ signal }) =>
      apiFetch<{ data: ContactLite[]; total: number }>(
        `/api/contacts?limit=8&sortBy=name&search=${encodeURIComponent(q)}`,
        { signal },
      ),
    enabled: enabled && q.length >= 2,
    staleTime: 30_000,
  });
}

// ---- Client portal preview -------------------------------------------------

export interface PortalPlan {
  id: string;
  carrierId: string | null;
  carrierName: string | null;
  planId: string | null;
  planName: string | null;
  planType: string;
  planYear: number;
  effectiveDate: string;
  disenrolledDate: string | null;
  status: string;
  agentId: string | null;
  agentFirstName: string | null;
  agentLastName: string | null;
}

export interface PortalMessage {
  id: string;
  channel: "sms" | "email";
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string | null;
  status: string;
  sentAt: string | null;
  createdAt: string;
}

export interface PortalDocument {
  id: string;
  name: string;
  category: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  createdAt: string;
}

export interface PortalPreview {
  contact: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    status: string;
    city: string | null;
    stateCode: string | null;
    zipCode: string | null;
    preferredLanguage: string | null;
    currentPlanType: string | null;
    optOutSms: boolean;
    optOutEmail: boolean;
  };
  plans: PortalPlan[];
  messages: PortalMessage[];
  documents: PortalDocument[];
  agent: { id: string; firstName: string; lastName: string; email: string; phone: string | null } | null;
  permissions: { canReplySms: boolean; canReplyEmail: boolean };
  asOf: string;
}

export function portalPreviewKey(contactId: string): unknown[] {
  return ["/api/client-portal/preview", contactId];
}

export function usePortalPreview(contactId: string | null) {
  return useQuery({
    queryKey: portalPreviewKey(contactId ?? ""),
    queryFn: ({ signal }) =>
      apiFetch<PortalPreview>(`/api/client-portal/preview/${encodeURIComponent(contactId!)}`, { signal }),
    enabled: Boolean(contactId),
    // Each fetch is an audited PHI view — don't refetch behind the user's back.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// ---- Appointments (optional: another workstream adds the API) --------------

export interface PortalAppointment {
  id: string;
  title: string;
  startsAt: string;
}

export type AppointmentsResult =
  | { available: false }
  | { available: true; items: PortalAppointment[] };

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * Normalizes whatever shape `GET /appointments?contactId=` returns (array or
 * `{data}`), keeping only future items. Exported for tests.
 */
export function normalizeAppointments(body: unknown, now = Date.now()): PortalAppointment[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  const out: PortalAppointment[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const startsAt = pickString(o, ["startsAt", "startAt", "start", "scheduledAt", "startTime"]);
    if (!startsAt || Number.isNaN(Date.parse(startsAt)) || Date.parse(startsAt) < now) continue;
    const status = pickString(o, ["status"]);
    if (status && /cancel/i.test(status)) continue;
    out.push({
      id: pickString(o, ["id"]) ?? startsAt,
      title: pickString(o, ["title", "type", "kind", "name"]) ?? "Appointment",
      startsAt,
    });
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 5);
}

/**
 * Upcoming appointments for a contact, if the appointments API exists in this
 * build. Any 404 / error means "not available yet" — never an error banner.
 */
export function useContactAppointments(contactId: string | null) {
  return useQuery({
    queryKey: ["/api/appointments", "portal", contactId ?? ""],
    queryFn: async ({ signal }): Promise<AppointmentsResult> => {
      try {
        const body = await apiFetch<unknown>(
          `/api/appointments?contactId=${encodeURIComponent(contactId!)}`,
          { signal },
        );
        return { available: true, items: normalizeAppointments(body) };
      } catch {
        return { available: false };
      }
    },
    enabled: Boolean(contactId),
    staleTime: 60_000,
    retry: false,
  });
}

// ---- Softphone -------------------------------------------------------------

export function usePhoneLookup(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return useQuery({
    queryKey: ["/api/softphone/lookup", digits],
    queryFn: ({ signal }) =>
      apiFetch<{ data: ContactLite[]; total: number }>(
        `/api/softphone/lookup?phone=${encodeURIComponent(digits)}`,
        { signal },
      ),
    enabled: digits.length >= 7 && digits.length <= 15,
    staleTime: 30_000,
  });
}

export interface PrecheckFailure {
  code:
    | "AGENT_NOT_LICENSED" | "AGENT_LICENSE_EXPIRED" | "AGENT_NO_AHIP" | "AGENT_NOT_CERTIFIED"
    | "NO_CONSENT" | "DNC" | "OUTSIDE_CALLING_HOURS" | "TIMEZONE_UNRESOLVED" | "MISSING_INPUT";
  detail: string;
}

export interface Precheck {
  okToCall: boolean;
  checks: {
    consent: boolean;
    dncClear: boolean;
    withinCallingHours: boolean | null;
    agentEligible: boolean | null;
  };
  failures: PrecheckFailure[];
  agent: { id: string; name: string; source: "requested" | "you" | "assigned" | null } | null;
  productLine: string;
  planYear: number;
  callingHours: { startHour: number; endHour: number; timezone: string | null; localTime: string | null };
  checkedAt: string;
}

export function usePrecheck(contactId: string | null) {
  return useQuery({
    queryKey: ["/api/softphone/precheck", contactId ?? ""],
    queryFn: ({ signal }) =>
      apiFetch<Precheck>(`/api/softphone/precheck?contactId=${encodeURIComponent(contactId!)}`, { signal }),
    enabled: Boolean(contactId),
    // Calling hours move with the clock.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export interface RecentCall {
  id: string;
  contactId: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

export const RECENT_CALLS_KEY = ["/api/softphone/recent-calls"] as const;

export function useRecentCalls(enabled = true) {
  return useQuery({
    enabled,
    queryKey: RECENT_CALLS_KEY,
    queryFn: ({ signal }) =>
      apiFetch<{ data: RecentCall[]; total: number }>("/api/softphone/recent-calls?limit=15", { signal }),
    staleTime: 15_000,
  });
}

export interface Disposition {
  code: string;
  label: string;
}

export function useDispositions() {
  return useQuery({
    queryKey: ["/api/softphone/dispositions"],
    queryFn: ({ signal }) => apiFetch<{ data: Disposition[] }>("/api/softphone/dispositions", { signal }),
    staleTime: Infinity,
  });
}

export interface ContactActivity {
  id: string;
  type: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function contactActivitiesKey(contactId: string): unknown[] {
  return ["/api/contacts", contactId, "activities", "softphone"];
}

export function useContactCallLogs(contactId: string | null) {
  return useQuery({
    queryKey: contactActivitiesKey(contactId ?? ""),
    queryFn: async ({ signal }) => {
      const rows = await apiFetch<ContactActivity[]>(
        `/api/contacts/${encodeURIComponent(contactId!)}/activities?limit=100`,
        { signal },
      );
      return rows.filter((a) => a.type === "call_log").slice(0, 10);
    },
    enabled: Boolean(contactId),
    staleTime: 15_000,
  });
}

// ---- Supervisor ------------------------------------------------------------

export interface SupervisorCallSummary {
  ticketId: string;
  status: string;
  parsedAt: string | null;
  contact: { id: string; name: string };
  agent: { id: string; name: string } | null;
  summary: string | null;
  suggestedDisposition: { code: string | null; category: string; confidence: number | null } | null;
  riskFlags: { kind: string; severity: "low" | "medium" | "high"; detail: string }[];
  actionItems: string[];
}

export function useSupervisorCallSummaries(enabled = true) {
  return useQuery({
    queryKey: ["/api/supervisor/call-summaries"],
    queryFn: ({ signal }) =>
      apiFetch<{ data: SupervisorCallSummary[]; total: number }>(
        "/api/supervisor/call-summaries?limit=20",
        { signal },
      ),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

// ---- Quoting ---------------------------------------------------------------

export interface Carrier {
  id: string;
  name: string;
  cmsContractNumber: string | null;
  isActive: boolean;
}

export function useCarriers() {
  return useQuery({
    queryKey: ["/api/carriers", "quoting"],
    queryFn: ({ signal }) => apiFetch<Carrier[]>("/api/carriers", { signal }),
    staleTime: 5 * 60_000,
  });
}

export interface ProviderResult {
  npi: string;
  name: string;
  credential: string | null;
  specialty: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
}

export interface ProviderQuery {
  lastName: string;
  firstName?: string;
  state?: string;
  zip?: string;
}

export function searchProviders(q: ProviderQuery): Promise<{ data: ProviderResult[]; total: number; source: string }> {
  const p = new URLSearchParams({ lastName: q.lastName.trim() });
  if (q.firstName?.trim()) p.set("firstName", q.firstName.trim());
  if (q.state?.trim()) p.set("state", q.state.trim());
  if (q.zip?.trim()) p.set("zip", q.zip.trim());
  return apiFetch(`/api/quoting/providers?${p.toString()}`);
}

// ---- Small shared formatters ----------------------------------------------

export function initialsOf(first?: string | null, last?: string | null): string {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";
}

/** "+13105550101" → "(310) 555-0101"; anything else is returned as typed. */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return raw;
}
