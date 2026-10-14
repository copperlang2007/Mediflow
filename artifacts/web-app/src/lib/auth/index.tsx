/**
 * Sign-in state for the whole app (ADR 0006: Google Cloud Identity Platform).
 *
 * <AuthProvider> follows the Firebase Auth user and exposes it through small
 * hooks (useAuth, useUser, useSession, useSignOut) that keep the field names
 * the screens already used (fullName, primaryEmailAddress, imageUrl).
 *
 * How the API learns who is calling: every ID token the SDK mints is written
 * to the `__session` cookie (same-origin, SameSite=Strict, an hour at most),
 * which plain fetch calls, downloads and EventSource streams carry, and the
 * generated API client also sends it as a Bearer header. Tokens last an hour;
 * the SDK refreshes them shortly before expiry, and this provider also asks for
 * a fresh one every few minutes and whenever the tab comes back, so the cookie
 * is never left stale. Demo builds have no sign-in: a fixed demo identity.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onIdTokenChanged, signOut as fbSignOut, type User } from "@firebase/auth";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { IS_DEMO_BUILD } from "@/lib/demo/isDemo";
import { authConfigured, firebaseAuth } from "./firebase";

export const SESSION_COOKIE = "__session";
const TOKEN_CHECK_EVERY_MS = 4 * 60 * 1000;
const COOKIE_MAX_AGE_SEC = 60 * 60;
/**
 * Oldest ID token the app sends. Google issues hour-long tokens, but the API's
 * step-up gates (exports, hard deletes) want one issued within 15 minutes, so
 * tokens are renewed well before that.
 */
const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;

let renewing: Promise<string> | null = null;
/**
 * The token this page last renewed and when, by this computer's clock. Age is
 * measured from here, never against the token's own issue time, so a fast or
 * slow computer clock can neither force a renewal on every call nor let a
 * stale token through.
 */
let known: { token: string; at: number } | null = null;

/**
 * A current ID token for `user`, renewed when this page did not obtain it
 * (restored from storage, renewed elsewhere) or obtained it more than
 * TOKEN_MAX_AGE_MS ago. One renewal at a time.
 */
export async function freshIdToken(user: User): Promise<string> {
  const token = await user.getIdToken();
  if (known && known.token === token && Date.now() - known.at < TOKEN_MAX_AGE_MS) return token;
  renewing ??= user
    .getIdToken(true)
    .then((fresh) => {
      known = { token: fresh, at: Date.now() };
      return fresh;
    })
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

export interface AppUser {
  id: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | undefined;
  primaryEmailAddress: { emailAddress: string } | null;
  emailVerified: boolean;
}

interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AppUser | null;
  firebaseUser: User | null;
  /** When this sign-in happened (ms since epoch), from the token. */
  signedInAt: number | null;
}

interface AuthContextValue extends AuthState {
  getToken: (opts?: { skipCache?: boolean }) => Promise<string | null>;
  signOut: (opts?: { redirectUrl?: string }) => Promise<void>;
  /** Re-read the user (e.g. after verifying their email) and mint a fresh token. */
  refresh: () => Promise<void>;
}

const env = import.meta.env as Record<string, string | undefined>;
const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

const DEMO_USER: AppUser = {
  id: env.VITE_DEMO_USER_ID ?? "00000000-0000-4000-8000-000000000010",
  firstName: env.VITE_DEMO_USER_FIRST_NAME ?? "Sarah",
  lastName: env.VITE_DEMO_USER_LAST_NAME ?? "Stevens",
  fullName: env.VITE_DEMO_USER_NAME ?? "Sarah Stevens",
  imageUrl: undefined,
  primaryEmailAddress: { emailAddress: env.VITE_DEMO_USER_EMAIL ?? "sarah@insureitall.example" },
  emailVerified: true,
};

function toAppUser(u: User): AppUser {
  const fullName = u.displayName?.trim() || null;
  const [first, ...rest] = (fullName ?? "").split(/\s+/);
  return {
    id: u.uid,
    fullName,
    firstName: first || null,
    lastName: rest.join(" ") || null,
    imageUrl: u.photoURL ?? undefined,
    primaryEmailAddress: u.email ? { emailAddress: u.email } : null,
    emailVerified: u.emailVerified,
  };
}

function writeSessionCookie(token: string | null): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; SameSite=Strict${secure}`
    : `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
}

/**
 * Make sure the session cookie holds a current token before a request; cheap
 * when it already does. Returns null (nothing to wait for) when nobody is
 * signed in, so a signed-out or demo request is not delayed at all.
 */
export function ensureFreshSession(): Promise<void> | null {
  if (IS_DEMO_BUILD) return null;
  const user = firebaseAuth()?.currentUser;
  if (!user) return null;
  // Cached token unless it is older than TOKEN_MAX_AGE_MS; a renewed one also fires onIdTokenChanged.
  return freshIdToken(user).then(
    (token) => writeSessionCookie(token),
    // Offline or revoked: the request goes out as is and the API answers 401.
    () => undefined,
  );
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(
    IS_DEMO_BUILD
      ? { isLoaded: true, isSignedIn: true, user: DEMO_USER, firebaseUser: null, signedInAt: null }
      : { isLoaded: false, isSignedIn: false, user: null, firebaseUser: null, signedInAt: null },
  );

  useEffect(() => {
    if (IS_DEMO_BUILD) return;
    const auth = firebaseAuth();
    if (!auth) {
      setState((s) => ({ ...s, isLoaded: true }));
      return;
    }
    setAuthTokenGetter(async () => (auth.currentUser ? freshIdToken(auth.currentUser) : null));
    const unsubscribe = onIdTokenChanged(auth, async (u) => {
      if (!u) {
        writeSessionCookie(null);
        setState({ isLoaded: true, isSignedIn: false, user: null, firebaseUser: null, signedInAt: null });
        return;
      }
      try {
        const result = await u.getIdTokenResult();
        writeSessionCookie(result.token);
        const signedInAt = Date.parse(result.authTime);
        setState({ isLoaded: true, isSignedIn: true, user: toAppUser(u), firebaseUser: u, signedInAt: Number.isFinite(signedInAt) ? signedInAt : null });
      } catch {
        writeSessionCookie(null);
        setState({ isLoaded: true, isSignedIn: false, user: null, firebaseUser: null, signedInAt: null });
      }
    });
    const tick = () => void ensureFreshSession();
    const timer = window.setInterval(tick, TOKEN_CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
      setAuthTokenGetter(null);
    };
  }, []);

  const getToken = useCallback(async (opts?: { skipCache?: boolean }): Promise<string | null> => {
    if (IS_DEMO_BUILD) return null;
    const u = firebaseAuth()?.currentUser;
    if (!u) return null;
    try {
      const token = opts?.skipCache === true ? await u.getIdToken(true) : await freshIdToken(u);
      writeSessionCookie(token);
      return token;
    } catch {
      return null;
    }
  }, []);

  const signOut = useCallback(async (opts?: { redirectUrl?: string }): Promise<void> => {
    const target = opts?.redirectUrl ?? (basePath || "/");
    if (IS_DEMO_BUILD) {
      window.location.href = target;
      return;
    }
    const auth = firebaseAuth();
    writeSessionCookie(null);
    if (auth) await fbSignOut(auth);
    window.location.assign(target);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const u = firebaseAuth()?.currentUser;
    if (!u) return;
    await u.reload();
    const token = await u.getIdToken(true);
    writeSessionCookie(token);
    const fresh = firebaseAuth()?.currentUser;
    if (fresh) setState((s) => ({ ...s, user: toAppUser(fresh), firebaseUser: fresh }));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ ...state, getToken, signOut, refresh }), [state, getToken, signOut, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("Sign-in hooks must be used inside <AuthProvider>");
  return ctx;
}

/** Signed-in state and a token getter (Bearer header for direct API calls). */
export function useAuth() {
  const { isLoaded, isSignedIn, getToken, signOut, user } = useAuthContext();
  return { isLoaded, isSignedIn, getToken, signOut, userId: user?.id ?? null };
}

export function useUser() {
  const { isLoaded, isSignedIn, user, firebaseUser, refresh } = useAuthContext();
  return { isLoaded, isSignedIn, user, firebaseUser, refresh };
}

/** This sign-in: its start time (what the idle guard compares with). */
export function useSession() {
  const { isLoaded, isSignedIn, signedInAt } = useAuthContext();
  return { isLoaded, isSignedIn, session: isSignedIn && signedInAt ? { createdAt: signedInAt } : null };
}

/** Sign out, then go to `redirectUrl` (default: the home page). */
export function useSignOut() {
  const { signOut } = useAuthContext();
  return { signOut };
}

/** Renders children only in the given sign-in state. */
export function Show({ when, children }: { when: "signed-in" | "signed-out"; children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuthContext();
  if (!isLoaded) return null;
  return (when === "signed-in") === isSignedIn ? <>{children}</> : null;
}

export { authConfigured };
