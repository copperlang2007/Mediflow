/**
 * Masked-by-default display for an agent's SSN / EIN / date of birth.
 *
 * The API only sends plaintext to PHI-privileged roles (super admin, agency
 * admin, compliance manager) and writes an audit_log row each time it does
 * (`contracting_pii_disclosed`). Even for those roles the page shows only the
 * last 4 until the viewer presses "Reveal". The value re-masks after
 * `REMASK_MS`, when the tab is hidden, and — because the state lives in this
 * component — whenever the viewer navigates away.
 *
 * Values that are already masked by the API (e.g. "***-**-****") are shown
 * as-is with no Reveal button: there is nothing to reveal.
 */
import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

export type SensitiveKind = "ssn" | "ein" | "dob";

export const REMASK_MS = 30_000;

const BULLET = "•";

function digitsOf(v: string): string {
  return v.replace(/\D/g, "");
}

/** True when the value still contains every character we'd hide. */
export function isAlreadyMasked(value: string): boolean {
  return /[*•]/.test(value) || digitsOf(value).length < 4;
}

/**
 * Last-4 mask for display.
 *   ssn  "999-77-8899" → "•••-••-8899"
 *   ein  "12-3456789"  → "••-•••6789"
 *   dob  "1985-11-04"  → "1985-••-••" (the last 4 of MM/DD/YYYY is the
 *        year; month and day stay hidden)
 */
export function maskSensitive(kind: SensitiveKind, value: string): string {
  if (isAlreadyMasked(value)) return value;
  const d = digitsOf(value);
  if (kind === "ssn") return `${BULLET.repeat(3)}-${BULLET.repeat(2)}-${d.slice(-4)}`;
  if (kind === "ein") return `${BULLET.repeat(2)}-${BULLET.repeat(3)}${d.slice(-4)}`;
  // dob — ISO date "YYYY-MM-DD"
  const year = /^\d{4}/.test(value) ? value.slice(0, 4) : d.slice(0, 4);
  return `${year}-${BULLET.repeat(2)}-${BULLET.repeat(2)}`;
}

export function SensitiveValue({
  kind,
  value,
  label,
  className,
}: {
  kind: SensitiveKind;
  value: string | null | undefined;
  /** Used in the button's accessible name, e.g. "SSN". */
  label: string;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  // Re-mask after a short window and whenever the tab is hidden.
  useEffect(() => {
    if (!revealed) return;
    const t = window.setTimeout(() => setRevealed(false), REMASK_MS);
    const onVis = () => {
      if (document.visibilityState === "hidden") setRevealed(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [revealed]);

  // A new value (another agent) always starts masked.
  useEffect(() => setRevealed(false), [value]);

  if (!value || String(value).trim().length === 0) {
    return <span className={className}>—</span>;
  }
  const canReveal = !isAlreadyMasked(value);
  const shown = revealed && canReveal ? value : maskSensitive(kind, value);

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="font-mono tabular-nums" data-testid={`sensitive-${kind}`}>
        {shown}
      </span>
      {canReveal && (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          data-testid={`reveal-${kind}`}
        >
          {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {revealed ? "Hide" : "Reveal"}
        </button>
      )}
    </span>
  );
}
