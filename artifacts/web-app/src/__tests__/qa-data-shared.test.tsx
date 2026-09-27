// @vitest-environment jsdom
/**
 * QA data pass — web side:
 *   - SensitiveValue masks SSN / EIN / DOB to the last 4 by default, reveals
 *     only on an explicit click, and re-masks after the timeout.
 *   - lib/licenses applies the shared active/expired definition.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { SensitiveValue, maskSensitive, isAlreadyMasked } from "@/components/shared";
import { REMASK_MS } from "@/components/shared/SensitiveValue";
import { isLicenseActive, isLicenseExpired, licenseEffectiveStatus } from "@/lib/licenses";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("maskSensitive", () => {
  it("keeps only the last 4 of an SSN / EIN and only the year of a DOB", () => {
    expect(maskSensitive("ssn", "999-77-8899")).toBe("•••-••-8899");
    expect(maskSensitive("ein", "12-3456789")).toBe("••-•••6789");
    expect(maskSensitive("dob", "1985-11-04")).toBe("1985-••-••");
  });

  it("leaves server-masked sentinels alone", () => {
    expect(isAlreadyMasked("***-**-****")).toBe(true);
    expect(maskSensitive("ssn", "***-**-****")).toBe("***-**-****");
  });
});

describe("<SensitiveValue>", () => {
  it("is masked by default and reveals only on click", () => {
    render(<SensitiveValue kind="ssn" label="SSN" value="999-77-8899" />);
    expect(screen.getByTestId("sensitive-ssn").textContent).toBe("•••-••-8899");
    expect(screen.queryByText("999-77-8899")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal SSN" }));
    expect(screen.getByTestId("sensitive-ssn").textContent).toBe("999-77-8899");
    fireEvent.click(screen.getByRole("button", { name: "Hide SSN" }));
    expect(screen.getByTestId("sensitive-ssn").textContent).toBe("•••-••-8899");
  });

  it("re-masks on its own after the timeout", () => {
    vi.useFakeTimers();
    render(<SensitiveValue kind="ein" label="EIN" value="12-3456789" />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal EIN" }));
    expect(screen.getByTestId("sensitive-ein").textContent).toBe("12-3456789");
    act(() => {
      vi.advanceTimersByTime(REMASK_MS + 10);
    });
    expect(screen.getByTestId("sensitive-ein").textContent).toBe("••-•••6789");
  });

  it("offers no Reveal for an already-masked value", () => {
    render(<SensitiveValue kind="ssn" label="SSN" value="***-**-****" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("re-masks when the value changes (another agent)", () => {
    const { rerender } = render(<SensitiveValue kind="ssn" label="SSN" value="999-77-8899" />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal SSN" }));
    rerender(<SensitiveValue kind="ssn" label="SSN" value="999-12-3456" />);
    expect(screen.getByTestId("sensitive-ssn").textContent).toBe("•••-••-3456");
  });
});

describe("lib/licenses", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  it("prefers the API's effectiveStatus", () => {
    expect(licenseEffectiveStatus({ status: "active", expiryDate: null, effectiveStatus: "expired" }, now)).toBe("expired");
  });
  it("falls back to the same rule: stored 'active' past expiry is expired", () => {
    const l = { status: "active", expiryDate: "2026-01-15T00:00:00Z" };
    expect(isLicenseActive(l, now)).toBe(false);
    expect(isLicenseExpired(l, now)).toBe(true);
    expect(isLicenseActive({ status: "active", expiryDate: "2027-01-15T00:00:00Z" }, now)).toBe(true);
  });
});
