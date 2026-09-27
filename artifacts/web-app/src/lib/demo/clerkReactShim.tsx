/**
 * Demo build shim for "@clerk/react".
 *
 * Swapped in for the real Clerk SDK ONLY in demo builds, via a Vite
 * resolve.alias gated on `VITE_DEMO_MODE` (see vite.config.ts). Production
 * builds never reference this file — they bundle the real "@clerk/react".
 *
 * It implements just the slice of Clerk's surface the app actually uses
 * (useUser / useAuth / useClerk / useSignIn / Show / ClerkProvider /
 * SignIn / SignUp), backed by a single fixed demo identity. The matching
 * backend (DEMO_MODE on the api-server) ignores tokens entirely and resolves
 * every request to the seeded demo user, so `getToken()` returning null here
 * is intentional and sufficient.
 *
 * Keep this in sync with the seeded demo admin in scripts/src/seed-demo.ts.
 */
import type { ReactNode } from "react";

const env = import.meta.env as Record<string, string | undefined>;

const DEMO_USER = {
  id: env.VITE_DEMO_USER_ID ?? "00000000-0000-4000-8000-000000000010",
  firstName: env.VITE_DEMO_USER_FIRST_NAME ?? "Sarah",
  lastName: env.VITE_DEMO_USER_LAST_NAME ?? "Stevens",
  fullName: env.VITE_DEMO_USER_NAME ?? "Sarah Stevens",
  imageUrl: undefined as string | undefined,
  primaryEmailAddress: {
    emailAddress: env.VITE_DEMO_USER_EMAIL ?? "sarah@insureitall.example",
  },
};

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

// --- Hooks -----------------------------------------------------------------

export function useUser() {
  return { isLoaded: true, isSignedIn: true as const, user: DEMO_USER };
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true as const,
    userId: DEMO_USER.id,
    orgId: env.VITE_DEMO_ORG_ID ?? "00000000-0000-4000-8000-000000000001",
    sessionId: "demo-session",
    // The demo backend does not check tokens; emit none.
    getToken: async (): Promise<string | null> => null,
    signOut: async (): Promise<void> => {
      window.location.href = basePath || "/";
    },
  };
}

export function useClerk() {
  return {
    user: DEMO_USER,
    signOut: async (_opts?: { redirectUrl?: string }): Promise<void> => {
      window.location.href = basePath || "/";
    },
    openUserProfile: (): void => {},
    // ClerkQueryClientCacheInvalidator subscribes here; demo never switches
    // users, so the listener is a no-op returning an unsubscribe fn.
    addListener: (_cb: (payload: { user: { id: string } | null }) => void): (() => void) => {
      return () => {};
    },
  };
}

export function useSignIn() {
  // Password reset is unreachable in demo (no sign-in flow); provide a inert
  // surface so the module type-checks and never throws.
  const reject = async (): Promise<{ error: string }> => ({
    error: "Sign-in is disabled in the demo deployment.",
  });
  return {
    isLoaded: true,
    fetchStatus: "idle" as const,
    signIn: {
      create: reject,
      resetPasswordEmailCode: {
        sendCode: reject,
        verifyCode: reject,
        submitPassword: reject,
      },
    },
  };
}

// --- Components ------------------------------------------------------------

export function ClerkProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: 12,
          left: 12,
          zIndex: 2147483647,
          padding: "4px 10px",
          borderRadius: 9999,
          background: "rgba(15, 23, 42, 0.85)",
          color: "#bfdbfe",
          font: "600 11px/1.4 'Inter', system-ui, sans-serif",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          pointerEvents: "none",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        }}
      >
        Demo · sample data
      </div>
    </>
  );
}

/** Clerk's <Show when="signed-in|signed-out">. Demo is always signed in. */
export function Show({ when, children }: { when?: string; children: ReactNode }) {
  if (when === "signed-out") return null;
  return <>{children}</>;
}

export function SignIn() {
  return (
    <div className="p-8 text-center text-white">
      Sign-in is disabled in the demo deployment.
    </div>
  );
}

export function SignUp() {
  return (
    <div className="p-8 text-center text-white">
      Sign-up is disabled in the demo deployment.
    </div>
  );
}

/** Demo builds have no real account to manage. */
export function UserProfile(_props: { routing?: string; path?: string }) {
  return <p className="text-sm text-muted-foreground">Account settings are not available in the demo.</p>;
}
