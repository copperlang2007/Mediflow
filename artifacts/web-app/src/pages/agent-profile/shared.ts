export const STATUS_STYLES: Record<string, string> = {
  onboarding: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-green-100 text-green-800 border-green-200",
  suspended: "bg-red-100 text-red-800 border-red-200",
  offboarding: "bg-orange-100 text-orange-800 border-orange-200",
  offboarded: "bg-slate-100 text-slate-600 border-slate-200",
};

export const CERT_STATUS_STYLES: Record<string, string> = {
  passed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  in_progress: "bg-blue-100 text-blue-800",
  not_started: "bg-slate-100 text-slate-600",
  waived: "bg-purple-100 text-purple-800",
};

export const LICENSE_STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  pending: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
  suspended: "bg-red-100 text-red-800",
  not_appointed: "bg-slate-100 text-slate-600",
};
