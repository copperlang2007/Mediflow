/**
 * Fail-closed dial backstops (ported from masterBRIDGE's compliance.ts
 * `checkMaxDialAttempts` / `checkReDialCooldown`, but per rolling window and
 * evaluated inside a per-number lock so two parallel clicks cannot both pass).
 *
 * masterBRIDGE used 10 lifetime attempts and a 2 hour cooldown. These defaults
 * are deliberately tighter and time-windowed. Override with env vars
 * (positive integers only; anything else falls back to the default):
 *   DIAL_MAX_ATTEMPTS, DIAL_WINDOW_HOURS, DIAL_REDIAL_COOLDOWN_MINUTES
 */
export interface DialLimits {
  /** Maximum call attempts to one contact/number inside the window. */
  maxAttempts: number;
  /** Rolling window length, hours. */
  windowHours: number;
  /** Minimum gap between two attempts to the same contact/number, minutes. */
  redialCooldownMinutes: number;
}

export const DEFAULT_DIAL_LIMITS: DialLimits = {
  maxAttempts: 3,
  windowHours: 24,
  redialCooldownMinutes: 30,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 10_000 ? n : fallback;
}

export function resolveDialLimits(env: NodeJS.ProcessEnv = process.env): DialLimits {
  return {
    maxAttempts: positiveInt(env.DIAL_MAX_ATTEMPTS, DEFAULT_DIAL_LIMITS.maxAttempts),
    windowHours: positiveInt(env.DIAL_WINDOW_HOURS, DEFAULT_DIAL_LIMITS.windowHours),
    redialCooldownMinutes: positiveInt(
      env.DIAL_REDIAL_COOLDOWN_MINUTES,
      DEFAULT_DIAL_LIMITS.redialCooldownMinutes,
    ),
  };
}
