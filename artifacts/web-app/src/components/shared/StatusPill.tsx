import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "navy";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success/12 text-success border-success/25",
  warning: "bg-warning/15 text-amber-700 border-warning/30 dark:text-warning",
  danger: "bg-destructive/10 text-destructive border-destructive/25",
  info: "bg-accent/10 text-accent border-accent/25",
  neutral: "bg-muted text-muted-foreground border-border",
  navy: "bg-navy-100 text-navy-800 border-navy-200 dark:bg-secondary dark:text-secondary-foreground dark:border-border",
};

/**
 * Maps the status words Mediflow's API returns (lower-case, snake_case) to a
 * colour. Anything not listed falls back to neutral grey, so an unknown value
 * is never shown as "good" or "bad" by accident.
 */
const STATUS_TONES: Record<string, StatusTone> = {
  // good
  active: "success", enrolled: "success", retained: "success", won: "success",
  completed: "success", complete: "success", passed: "success", paid: "success",
  approved: "success", compliant: "success", reconciled: "success", signed: "success",
  available: "success", resolved: "success", matched: "success",
  // needs attention
  pending: "warning", onboarding: "warning", expiring: "warning", in_progress: "warning",
  in_review: "warning", submitted: "warning", draft: "warning", offboarding: "warning",
  due_soon: "warning", open: "info", new: "info", contacted: "info", qualified: "info",
  prospect: "info", lead: "navy",
  // bad
  overdue: "danger", expired: "danger", suspended: "danger", lost: "danger",
  failed: "danger", rejected: "danger", cancelled: "danger", canceled: "danger",
  lapsed: "danger", missing: "danger", do_not_contact: "danger", unmatched: "danger",
  // neutral
  offboarded: "neutral", inactive: "neutral", away: "neutral", archived: "neutral",
};

export function statusTone(status: string): StatusTone {
  return STATUS_TONES[status.toLowerCase().replace(/[\s-]+/g, "_")] ?? "neutral";
}

/** "do_not_contact" → "Do not contact" */
export function humanizeStatus(status: string): string {
  const s = status.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Small rounded status label. Pass a raw API `status` and it picks the colour
 * and a readable label; or pass `tone` + children to control both.
 */
export function StatusPill({
  status,
  tone,
  children,
  className,
}: {
  status?: string;
  tone?: StatusTone;
  children?: ReactNode;
  className?: string;
}) {
  const resolvedTone = tone ?? (status ? statusTone(status) : "neutral");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[resolvedTone],
        className,
      )}
    >
      {children ?? (status ? humanizeStatus(status) : null)}
    </span>
  );
}
