/**
 * Pure (no-IO) automation rule evaluation helpers — separated from
 * runAutomationRules.ts so they can be unit-tested without pulling in
 * @workspace/db (which fails at import time when DATABASE_URL isn't set).
 */

export interface AutomationCondition {
  field: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt" | "exists";
  value: unknown;
  logic?: "and" | "or";
}

// ---- Condition evaluation ----

export function evaluateCondition(
  cond: AutomationCondition,
  ctx: Record<string, unknown>,
): boolean {
  const actual = ctx[cond.field];
  switch (cond.operator) {
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "contains":
      return typeof actual === "string" && actual.includes(String(cond.value));
    case "gt":
      return Number(actual) > Number(cond.value);
    case "lt":
      return Number(actual) < Number(cond.value);
    case "exists":
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

export function evaluateConditions(
  conditions: AutomationCondition[],
  ctx: Record<string, unknown>,
): boolean {
  if (conditions.length === 0) return true;
  // Process conditions respecting AND/OR logic. Default logic for the first
  // condition is AND; each subsequent condition uses its own `logic` to
  // combine with the running result.
  let result = evaluateCondition(conditions[0]!, ctx);
  for (let i = 1; i < conditions.length; i++) {
    const cond = conditions[i]!;
    const logic = cond.logic ?? "and";
    if (logic === "or") {
      result = result || evaluateCondition(cond, ctx);
    } else {
      result = result && evaluateCondition(cond, ctx);
    }
  }
  return result;
}

// ---- Variable substitution ----

/**
 * Replace `{{key}}` placeholders in an action config string with values from
 * the enriched trigger context. Unknown keys collapse to an empty string so
 * partially-templated rules don't blow up on missing values.
 */
export function renderTemplate(
  text: string,
  ctx: Record<string, unknown>,
): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>((acc, part) => {
        if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, ctx);
    if (value === undefined || value === null) return "";
    return String(value);
  });
}

export function renderConfig<T extends Record<string, unknown>>(
  config: T,
  ctx: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = typeof v === "string" ? renderTemplate(v, ctx) : v;
  }
  return out as T;
}
