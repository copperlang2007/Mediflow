// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const signOut = vi.fn(async (_opts?: { redirectUrl?: string }) => undefined);
const fakeUser = { uid: "uid-1", email: "pat@agency.example" };

vi.mock("@/lib/auth", () => ({
  useUser: () => ({ firebaseUser: fakeUser }),
  useSignOut: () => ({ signOut }),
}));
// The enrollment steps talk to Identity Platform; here only the hand-off matters.
vi.mock("@/components/auth/TotpEnrollment", () => ({
  TotpEnrollment: ({ onEnrolled }: { onEnrolled: () => void }) => (
    <button type="button" onClick={onEnrolled}>
      finish-enrollment
    </button>
  ),
}));

import { MfaEnrollmentGate } from "@/components/auth/MfaEnrollmentGate";

describe("MfaEnrollmentGate", () => {
  beforeEach(() => signOut.mockClear());

  it("explains the requirement and offers authenticator setup right there", () => {
    render(<MfaEnrollmentGate />);
    expect(screen.getByRole("heading", { name: /turn on two-step verification/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "finish-enrollment" })).toBeTruthy();
  });

  it("after setup, signs out and sends the user to sign in again with a code", () => {
    render(<MfaEnrollmentGate />);
    fireEvent.click(screen.getByRole("button", { name: "finish-enrollment" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    const target = signOut.mock.calls[0]![0]!.redirectUrl!;
    expect(target).toContain("/sign-in?notice=mfa-on");
    expect(decodeURIComponent(target)).toContain("redirect_url=/dashboard");
  });

  it("lets the user sign out", () => {
    render(<MfaEnrollmentGate />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });
});
