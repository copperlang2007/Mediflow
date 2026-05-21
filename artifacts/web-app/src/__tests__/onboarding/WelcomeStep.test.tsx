// @vitest-environment jsdom
/**
 * Render tests for the wizard's WelcomeStep. WelcomeStep is a pure
 * presentational component with no external dependencies, so it's a clean
 * exercise of the substitution rule (test what's safe to test).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeStep } from "@/pages/onboarding/steps/WelcomeStep";

describe("WelcomeStep", () => {
  it("renders all four onboarding stages", () => {
    render(<WelcomeStep onContinue={() => {}} />);
    expect(screen.getByText(/1\. Your profile/i)).toBeInTheDocument();
    expect(screen.getByText(/2\. Carriers/i)).toBeInTheDocument();
    expect(screen.getByText(/3\. Sign paperwork/i)).toBeInTheDocument();
    expect(screen.getByText(/4\. Submitted/i)).toBeInTheDocument();
  });

  it("explains that SSN/EIN are encrypted at rest", () => {
    render(<WelcomeStep onContinue={() => {}} />);
    expect(
      screen.getByText(/encrypted at rest with AES-256-GCM/i),
    ).toBeInTheDocument();
  });

  it("fires onContinue when the 'Get started' button is clicked", () => {
    const onContinue = vi.fn();
    render(<WelcomeStep onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
