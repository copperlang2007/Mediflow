/**
 * Google Cloud Identity Platform (Firebase Auth SDK) for the browser (ADR 0006).
 *
 * Config comes from the build: VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN
 * and VITE_FIREBASE_PROJECT_ID. All three are public by design (they identify
 * the project; they grant nothing on their own). Without them the app shows
 * the deployment-config screen instead of a sign-in that cannot work.
 */
import { initializeApp, type FirebaseApp } from "@firebase/app";
import { browserLocalPersistence, indexedDBLocalPersistence, initializeAuth, type Auth } from "@firebase/auth";

const env = import.meta.env as Record<string, string | undefined>;

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY?.trim() ?? "",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() ?? "",
  projectId: env.VITE_FIREBASE_PROJECT_ID?.trim() ?? "",
};

export const authConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

/** The Auth instance; null when sign-in is not configured for this build. */
export function firebaseAuth(): Auth | null {
  if (!authConfigured) return null;
  app ??= initializeApp(firebaseConfig);
  // initializeAuth without a popup/redirect resolver (getAuth() adds one): we
  // only use email/password, and the resolver would load the auth-domain
  // iframe and apis.google.com scripts on Safari/iOS, which the CSP blocks.
  auth ??= initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  return auth;
}

/** Plain-words message for a Firebase Auth error code (never the raw error). */
export function authErrorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  const code = (err as { code?: string } | null)?.code ?? "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "That email and password don't match. Check them, or reset your password.";
    case "auth/email-already-in-use":
      return "An account with this email already exists. Sign in instead, or reset your password.";
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return "Choose a stronger password: at least 12 characters, mixing letters, numbers and symbols.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes, then try again.";
    case "auth/invalid-verification-code":
    case "auth/invalid-totp-code" as string:
      return "That code isn't right. Enter the current 6-digit code from your authenticator app.";
    case "auth/network-request-failed":
      return "Can't reach the sign-in service. Check your connection and try again.";
    case "auth/user-disabled":
      return "This sign-in has been turned off. Ask your agency administrator.";
    case "auth/requires-recent-login":
      return "For your security, enter your password again to continue.";
    case "auth/unverified-email":
      return "Verify your email address first, then try again.";
    default:
      return fallback;
  }
}
