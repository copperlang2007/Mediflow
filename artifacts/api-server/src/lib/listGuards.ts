/**
 * Shared list-endpoint pagination guards.
 *
 * Centralizes the parsing of `limit` and `offset` query params so every
 * route enforces the same hard ceiling (`MAX_LIST_LIMIT`) and ignores
 * malformed input the same way. Per-route callers may pass tighter
 * `defaultLimit` / `max` values for heavy lists (e.g. audit log,
 * messages — typically capped at 500).
 */

export const MAX_LIST_LIMIT = 1000;

export function safeLimit(
  raw: unknown,
  defaultLimit = 50,
  max = MAX_LIST_LIMIT,
): number {
  const n = parseInt(typeof raw === "string" ? raw : "", 10);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(n, max);
}

export function safeOffset(raw: unknown): number {
  const n = parseInt(typeof raw === "string" ? raw : "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
