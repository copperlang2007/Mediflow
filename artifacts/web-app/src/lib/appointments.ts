/**
 * Calendar API client + display helpers (stage2/calendar-branding).
 * Thin wrappers over apiFetch; server rules live in api-server routes/appointments.ts.
 */
import { apiFetch, type ApiFetchOptions } from "@/lib/api";

export const APPOINTMENT_TYPES = ["enrollment", "review", "renewal", "consultation", "other"] as const;
export const APPOINTMENT_STATUSES = ["confirmed", "pending", "completed", "cancelled", "no_show"] as const;
export const LOCATION_TYPES = ["office", "phone", "video", "home"] as const;

export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type LocationType = (typeof LOCATION_TYPES)[number];

export interface Appointment {
  id: string;
  contactId: string | null;
  agentId: string | null;
  type: AppointmentType;
  title: string;
  notes: string | null;
  notesMasked: boolean;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  locationType: LocationType;
  locationDetail: string | null;
  meetingUrl: string | null;
  reminderSentAt: string | null;
  createdBy: string | null;
  contact: { id: string; firstName: string | null; lastName: string | null } | null;
  agent: { id: string; firstName: string | null; lastName: string | null } | null;
}

export type AppointmentSummary = Record<"total" | AppointmentStatus, number>;

export interface AppointmentList {
  data: Appointment[];
  summary: AppointmentSummary;
  scope: "own" | "org";
}

export interface AppointmentInput {
  title: string;
  type: AppointmentType;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  contactId: string | null;
  agentId: string | null;
  notes: string | null;
  locationType: LocationType;
  locationDetail: string | null;
  meetingUrl: string | null;
}

export interface ContactOption {
  id: string;
  firstName: string;
  lastName: string;
  assignedAgentId: string | null;
}

export interface AgentOption {
  id: string;
  firstName: string;
  lastName: string;
  isMe: boolean;
}

const json = (body: unknown): ApiFetchOptions => ({
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

export const appointmentsKey = (from: string, to: string, agentId?: string) =>
  ["/api/appointments", from, to, agentId ?? "all"] as const;

export function listAppointments(from: string, to: string, agentId?: string): Promise<AppointmentList> {
  const q = new URLSearchParams({ from, to });
  if (agentId) q.set("agentId", agentId);
  return apiFetch<AppointmentList>(`/api/appointments?${q.toString()}`);
}

export function createAppointment(input: AppointmentInput): Promise<Appointment> {
  return apiFetch<Appointment>("/api/appointments", { method: "POST", ...json(input) });
}

export function updateAppointment(id: string, input: Partial<AppointmentInput>): Promise<Appointment> {
  return apiFetch<Appointment>(`/api/appointments/${encodeURIComponent(id)}`, { method: "PATCH", ...json(input) });
}

export function deleteAppointment(id: string): Promise<void> {
  return apiFetch<void>(`/api/appointments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function searchContactOptions(search: string): Promise<{ data: ContactOption[] }> {
  const q = new URLSearchParams();
  if (search) q.set("search", search);
  return apiFetch(`/api/appointments/contact-options?${q.toString()}`);
}

export function listAgentOptions(): Promise<{ data: AgentOption[] }> {
  return apiFetch("/api/appointments/agent-options");
}

export const TYPE_LABELS: Record<AppointmentType, string> = {
  enrollment: "Enrollment",
  review: "Review",
  renewal: "Renewal",
  consultation: "Consultation",
  other: "Other",
};

/** Chip colours from the agencyBRIDGE calendar legend. */
export const TYPE_CHIP: Record<AppointmentType, string> = {
  enrollment: "bg-navy-700 text-white border-navy-700 dark:bg-navy-600 dark:border-navy-600",
  review: "bg-accent/15 text-accent border-accent/30",
  renewal: "bg-success/15 text-success border-success/30",
  consultation: "bg-warning/15 text-amber-700 border-warning/40 dark:text-warning",
  other: "bg-muted text-muted-foreground border-border",
};

export const TYPE_DOT: Record<AppointmentType, string> = {
  enrollment: "bg-navy-700 dark:bg-navy-300",
  review: "bg-accent",
  renewal: "bg-success",
  consultation: "bg-warning",
  other: "bg-muted-foreground",
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  confirmed: "Confirmed",
  pending: "Pending",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const STATUS_TONE: Record<AppointmentStatus, "success" | "warning" | "neutral" | "danger" | "info"> = {
  confirmed: "success",
  pending: "warning",
  completed: "neutral",
  cancelled: "danger",
  no_show: "danger",
};

export const LOCATION_LABELS: Record<LocationType, string> = {
  office: "Office",
  phone: "Phone",
  video: "Video call",
  home: "Home visit",
};

export function personName(p: { firstName: string | null; lastName: string | null } | null): string | null {
  if (!p) return null;
  const n = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return n || null;
}
