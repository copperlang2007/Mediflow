// ──────────────────────────────────────────────
// Shared style maps & helpers for CRM tabs
// ──────────────────────────────────────────────

export const CONTACT_STATUS_STYLES: Record<string, string> = {
  lead: "bg-blue-100 text-blue-800",
  prospect: "bg-purple-100 text-purple-800",
  enrolled: "bg-green-100 text-green-800",
  retained: "bg-emerald-100 text-emerald-800",
  lost: "bg-red-100 text-red-800",
  do_not_contact: "bg-slate-100 text-slate-600",
};

export const LEAD_STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-amber-100 text-amber-800",
  qualified: "bg-purple-100 text-purple-800",
  disqualified: "bg-red-100 text-red-800",
  converted: "bg-green-100 text-green-800",
};

export const PLAN_TYPE_LABELS: Record<string, string> = {
  MA: "Medicare Advantage", PDP: "Part D", MAPD: "MAPD", supp: "Supplement", other: "Other",
};

export const SEQ_STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-amber-100 text-amber-800",
  draft: "bg-slate-100 text-slate-600",
};

export function initials(first: string, last: string) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
}
