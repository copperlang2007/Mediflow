// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const reload = vi.fn(async () => undefined);
const getToken = vi.fn(async () => "fresh-token");
const signOut = vi.fn(async () => undefined);

vi.mock("@clerk/react", () => ({
  UserProfile: () => <div data-testid="user-profile" />,
  useSession: () => ({ session: { reload } }),
  useAuth: () => ({ getToken }),
  useClerk: () => ({ signOut }),
}));

import { MfaEnrollmentGate } from "@/components/auth/MfaEnrollmentGate";

describe("MfaEnrollmentGate", () => {
  beforeEach(() => {
    reload.mockClear();
    getToken.mockClear();
    signOut.mockClear();
  });

  it("explains the requirement and shows the Clerk profile to enroll", () => {
    render(<MfaEnrollmentGate onEnrolled={async () => false} />);
    expect(screen.getByRole("heading", { name: /turn on two-step verification/i })).toBeTruthy();
    expect(screen.getByTestId("user-profile")).toBeTruthy();
  });

  it("refreshes the session token before re-checking, and says so when MFA is still off", async () => {
    const onEnrolled = vi.fn(async () => false);
    render(<MfaEnrollmentGate onEnrolled={onEnrolled} />);
    fireEvent.click(screen.getByRole("button", { name: /i've turned it on/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/isn't on yet/i));
    expect(reload).toHaveBeenCalled();
    expect(getToken).toHaveBeenCalledWith({ skipCache: true });
    expect(reload.mock.invocationCallOrder[0]).toBeLessThan(onEnrolled.mock.invocationCallOrder[0]);
  });

  it("shows no warning once the re-check finds MFA on", async () => {
    render(<MfaEnrollmentGate onEnrolled={async () => true} />);
    fireEvent.click(screen.getByRole("button", { name: /i've turned it on/i }));
    await waitFor(() => expect(getToken).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets the user sign out", () => {
    render(<MfaEnrollmentGate onEnrolled={async () => false} />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });
});
