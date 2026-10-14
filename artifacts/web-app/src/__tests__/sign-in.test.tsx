// @vitest-environment jsdom
/**
 * Sign-in (ADR 0006): password first; when the account has an authenticator
 * app, the 6-digit code; errors in plain words; and the post-sign-in
 * redirect only ever stays on this site.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const fb = vi.hoisted(() => ({
  signIn: vi.fn(),
  resolveSignIn: vi.fn(async () => ({})),
  assertionForSignIn: vi.fn((uid: string, code: string) => ({ uid, code })),
}));

vi.mock("@firebase/auth", () => ({
  signInWithEmailAndPassword: fb.signIn,
  getMultiFactorResolver: () => ({ hints: [{ factorId: "totp", uid: "factor-1" }], resolveSignIn: fb.resolveSignIn }),
  TotpMultiFactorGenerator: { FACTOR_ID: "totp", assertionForSignIn: fb.assertionForSignIn },
}));
vi.mock("@/lib/auth/firebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/firebase")>()),
  firebaseAuth: () => ({}),
}));

import SignInPage from "@/pages/sign-in";
import { redirectTarget } from "@/components/auth/AuthFrame";

function renderAt(path: string) {
  const { hook, searchHook } = memoryLocation({ path });
  render(
    <Router hook={hook} searchHook={searchHook}>
      <SignInPage />
    </Router>,
  );
}

function fillPassword() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pat@agency.example" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
}

describe("sign-in", () => {
  beforeEach(() => {
    fb.signIn.mockReset();
    fb.resolveSignIn.mockClear();
    fb.assertionForSignIn.mockClear();
  });

  it("asks for the authenticator code after the password, and completes the sign-in with it", async () => {
    fb.signIn.mockRejectedValueOnce(Object.assign(new Error("mfa"), { code: "auth/multi-factor-auth-required" }));
    renderAt("/sign-in");
    fillPassword();
    const code = await screen.findByLabelText("Code");
    fireEvent.change(code, { target: { value: "123 456" } });
    fireEvent.click(screen.getByRole("button", { name: /verify and sign in/i }));
    await waitFor(() => expect(fb.resolveSignIn).toHaveBeenCalledTimes(1));
    expect(fb.assertionForSignIn).toHaveBeenCalledWith("factor-1", "123456");
  });

  it("says plainly when the email and password don't match", async () => {
    fb.signIn.mockRejectedValueOnce(Object.assign(new Error("bad"), { code: "auth/invalid-credential" }));
    renderAt("/sign-in");
    fillPassword();
    expect((await screen.findByRole("alert")).textContent).toMatch(/don't match/i);
    expect(screen.queryByLabelText("Code")).toBeNull();
  });

  it("shows the notice after two-step verification was just turned on", () => {
    renderAt("/sign-in?notice=mfa-on");
    expect(screen.getByRole("status").textContent).toMatch(/two-step verification is on/i);
  });

  it("keeps the invitation link when sending a new person to create a login", () => {
    renderAt("/sign-in?redirect_url=%2Faccept-invite%3Ftoken%3Dabc");
    expect(screen.getByRole("link", { name: /create your login/i }).getAttribute("href")).toBe(
      "/sign-up?redirect_url=%2Faccept-invite%3Ftoken%3Dabc",
    );
  });
});

describe("where to go after signing in", () => {
  it("follows a path on this site", () => {
    expect(redirectTarget("?redirect_url=%2Faccept-invite%3Ftoken%3Dabc")).toBe("/accept-invite?token=abc");
  });

  it("never leaves the site", () => {
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", ""]) {
      expect(redirectTarget(`?redirect_url=${encodeURIComponent(bad)}`)).toBe("/dashboard");
    }
  });
});
