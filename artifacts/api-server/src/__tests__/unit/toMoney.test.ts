import { describe, it, expect } from "vitest";
import { toMoney, toRequiredMoney } from "../../lib/commissionParsers";

describe("toMoney", () => {
  it("parses plain numbers", () => {
    expect(toMoney("500")).toBe("500.00");
    expect(toMoney("1234.5")).toBe("1234.50");
  });

  it("strips currency formatting ($ and thousands separators)", () => {
    expect(toMoney("$1,234.56")).toBe("1234.56");
    expect(toMoney(" $ 99.9 ")).toBe("99.90");
  });

  it("handles explicit negative sign", () => {
    expect(toMoney("-30.00")).toBe("-30.00");
    expect(toMoney("-$1,200.00")).toBe("-1200.00");
  });

  it("treats accounting parentheses as negative (chargeback notation)", () => {
    // Regression: "(500.00)" is accounting notation for -500.00. Previously
    // the parens were stripped without negating, turning carrier chargebacks
    // into positive credits and breaking clawback reporting.
    expect(toMoney("(500.00)")).toBe("-500.00");
    expect(toMoney("($1,234.56)")).toBe("-1234.56");
    expect(toMoney("(0.00)")).toBe("0.00");
  });

  it("returns null for empty / non-numeric input", () => {
    expect(toMoney(null)).toBeNull();
    expect(toMoney(undefined)).toBeNull();
    expect(toMoney("")).toBeNull();
    expect(toMoney("   ")).toBeNull();
    expect(toMoney("abc")).toBeNull();
    expect(toMoney("()")).toBeNull();
  });

  it("toRequiredMoney falls back to 0.00", () => {
    expect(toRequiredMoney(null)).toBe("0.00");
    expect(toRequiredMoney("(75.00)")).toBe("-75.00");
  });
});
