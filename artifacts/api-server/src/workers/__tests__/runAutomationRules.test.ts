import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  evaluateConditions,
  renderTemplate,
  type AutomationCondition,
} from "../automationRulesEngine";

// ─── Condition evaluation ─────────────────────────────────────────────────────
describe("evaluateCondition", () => {
  const ctx = {
    status: "active",
    daysUntilExpiry: 12,
    name: "Jane Doe",
  };

  it("matches eq", () => {
    expect(evaluateCondition({ field: "status", operator: "eq", value: "active" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "status", operator: "eq", value: "paused" }, ctx)).toBe(false);
  });

  it("matches neq", () => {
    expect(evaluateCondition({ field: "status", operator: "neq", value: "paused" }, ctx)).toBe(true);
  });

  it("matches contains on strings", () => {
    expect(evaluateCondition({ field: "name", operator: "contains", value: "Jane" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "name", operator: "contains", value: "John" }, ctx)).toBe(false);
  });

  it("compares gt/lt numerically", () => {
    expect(evaluateCondition({ field: "daysUntilExpiry", operator: "lt", value: 30 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "daysUntilExpiry", operator: "gt", value: 30 }, ctx)).toBe(false);
  });

  it("checks exists", () => {
    expect(evaluateCondition({ field: "status", operator: "exists", value: null }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "missing", operator: "exists", value: null }, ctx)).toBe(false);
  });
});

describe("evaluateConditions", () => {
  const ctx = { a: 1, b: 2, c: "yes" };

  it("returns true when no conditions are supplied", () => {
    expect(evaluateConditions([], ctx)).toBe(true);
  });

  it("ANDs conditions by default", () => {
    const conds: AutomationCondition[] = [
      { field: "a", operator: "eq", value: 1 },
      { field: "b", operator: "eq", value: 2 },
    ];
    expect(evaluateConditions(conds, ctx)).toBe(true);
  });

  it("respects per-condition OR logic", () => {
    const conds: AutomationCondition[] = [
      { field: "a", operator: "eq", value: 999 },
      // The second condition's logic overrides AND, so the result is true even
      // though the first is false.
      { field: "b", operator: "eq", value: 2, logic: "or" } as AutomationCondition & {
        logic?: string;
      },
    ];
    expect(evaluateConditions(conds, ctx)).toBe(true);
  });

  it("fails when AND chain has any false", () => {
    const conds: AutomationCondition[] = [
      { field: "a", operator: "eq", value: 1 },
      { field: "b", operator: "eq", value: 999 },
    ];
    expect(evaluateConditions(conds, ctx)).toBe(false);
  });
});

// ─── Template substitution ────────────────────────────────────────────────────
describe("renderTemplate", () => {
  const ctx = {
    firstName: "Jane",
    daysUntilExpiry: 30,
    nested: { value: "deep" },
  };

  it("substitutes simple {{var}} placeholders", () => {
    expect(renderTemplate("Hi {{firstName}}", ctx)).toBe("Hi Jane");
  });

  it("collapses unknown vars to empty string", () => {
    expect(renderTemplate("Hello {{unknown}}!", ctx)).toBe("Hello !");
  });

  it("handles dotted paths", () => {
    expect(renderTemplate("Got: {{nested.value}}", ctx)).toBe("Got: deep");
  });

  it("coerces non-string values to strings", () => {
    expect(renderTemplate("In {{daysUntilExpiry}} days", ctx)).toBe("In 30 days");
  });

  it("tolerates whitespace inside braces", () => {
    expect(renderTemplate("{{ firstName }}", ctx)).toBe("Jane");
  });
});
