// @vitest-environment jsdom
/**
 * AuthProvider (ADR 0006): follows the Identity Platform user, writes each
 * fresh ID token to the `__session` cookie the API reads, registers it for
 * the generated API client, and clears both on sign-out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const fb = vi.hoisted(() => ({
  listener: null as null | ((u: unknown) => void | Promise<void>),
  signOut: vi.fn(async () => undefined),
}));
const tokenGetter = vi.hoisted(() => ({ current: null as null | (() => unknown) }));

vi.mock("@firebase/auth", () => ({
  onIdTokenChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    fb.listener = cb;
    return () => undefined;
  },
  signOut: fb.signOut,
}));
vi.mock("@/lib/auth/firebase", () => ({
  authConfigured: true,
  firebaseAuth: () => ({ currentUser: null }),
}));
vi.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: (g: (() => unknown) | null) => {
    tokenGetter.current = g;
  },
}));

import { AuthProvider, useAuth, useUser } from "@/lib/auth";

function Probe() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  return <div data-testid="state">{!isLoaded ? "loading" : isSignedIn ? `in:${user?.fullName}:${user?.primaryEmailAddress?.emailAddress}` : "out"}</div>;
}

const cookie = () => document.cookie.split("; ").find((c) => c.startsWith("__session=")) ?? null;

describe("AuthProvider", () => {
  beforeEach(() => {
    document.cookie = "__session=; Path=/; Max-Age=0";
    fb.listener = null;
  });

  it("writes the ID token to the session cookie on sign-in and clears it on sign-out", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("loading");
    expect(tokenGetter.current).toBeTypeOf("function");

    const user = {
      uid: "uid-1",
      displayName: "Pat Example",
      email: "pat@agency.example",
      emailVerified: true,
      photoURL: null,
      getIdTokenResult: async () => ({ token: "header.payload.sig", authTime: new Date(1_800_000_000_000).toUTCString() }),
    };
    await act(async () => {
      await fb.listener!(user);
    });
    expect(screen.getByTestId("state").textContent).toBe("in:Pat Example:pat@agency.example");
    expect(cookie()).toBe("__session=header.payload.sig");

    await act(async () => {
      await fb.listener!(null);
    });
    expect(screen.getByTestId("state").textContent).toBe("out");
    expect(cookie()).toBeNull();
  });
});
