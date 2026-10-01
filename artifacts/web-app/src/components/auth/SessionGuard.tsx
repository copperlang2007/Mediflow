import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, useClerk, useSession } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { IS_DEMO_BUILD } from "@/lib/demo/isDemo";
import { apiFetch } from "@/lib/api";
import {
  DEFAULT_IDLE_MINUTES,
  SESSION_EXPIRED_EVENT,
  clearSessionMarkers,
  isCallInProgress,
  isUsingEmbeddedDocument,
  signInUrlAfterSignOut,
  markActivity,
  markSeen,
  saveIdleMinutes,
  staleReason,
  storedIdleMinutes,
} from "@/lib/auth/sessionGuard";

const CHECK_EVERY_MS = 15_000;
const FRESH_LOGIN_MS = 30 * 1000;
const FRESH_LOGIN_SKEW_MS = 10 * 1000;
const RETRY_SIGN_OUT_MS = 3_000;
const MAX_RETRY_WAIT_MS = 30_000;
const REFRESH_STATUS_EVERY_MS = 5 * 60 * 1000;
const ACTIVITY_WRITE_EVERY_MS = 5_000;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;
const CALL_HEARTBEAT_EVERY_MS = 60_000;

/**
 * Wraps the whole app. Signs the user out (and lands on the sign-in screen)
 * when they have been idle too long, or came back after leaving. Renders
 * nothing until that check has run, so a stale session never flashes the
 * dashboard.
 */
export function SessionGuard({
  idleMinutes = DEFAULT_IDLE_MINUTES,
  children,
}: {
  idleMinutes?: number;
  children: React.ReactNode;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  // useSession (not useClerk().session) so this re-renders when the session arrives.
  const { session } = useSession();
  const qc = useQueryClient();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [checked, setChecked] = useState(false);
  // True from the moment a sign-out starts until Clerk confirms it, so a
  // failing sign-out never leaves an expired user looking at their data.
  const [blocked, setBlocked] = useState(false);
  const loopRef = useRef(false);
  // An expiry notice that arrived during a live call; acted on once it ends.
  const expiredDuringCallRef = useRef(false);
  const endingRef = useRef(false);

  // Returns true once Clerk has confirmed the sign-out.
  const endSession = useCallback(async (): Promise<boolean> => {
    if (endingRef.current) return false;
    endingRef.current = true;
    clearSessionMarkers();
    try {
      localStorage.removeItem("mediflow:view-as-org");
    } catch {
      // ignore
    }
    // Purge cached data first so it is gone even if Clerk is unreachable.
    qc.clear();
    try {
      await signOut({ redirectUrl: signInUrlAfterSignOut(basePath, window.location) });
      return true;
    } catch {
      return false;
    } finally {
      endingRef.current = false;
    }
  }, [signOut, qc, basePath]);

  const signOutUntilDone = useCallback(async (): Promise<void> => {
    if (loopRef.current) return;
    loopRef.current = true;
    setBlocked(true);
    try {
      for (let attempt = 0; !(await endSession()); attempt++) {
        const wait = Math.min(RETRY_SIGN_OUT_MS * 2 ** attempt, MAX_RETRY_WAIT_MS);
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      loopRef.current = false;
      setBlocked(false);
    }
  }, [endSession]);

  const minutesNow = useCallback((): number => {
    const status = qc.getQueryData<{ sessionTimeoutMinutes?: number }>(["auth", "status"]);
    if (status?.sessionTimeoutMinutes) saveIdleMinutes(status.sessionTimeoutMinutes);
    return status?.sessionTimeoutMinutes ?? storedIdleMinutes() ?? idleMinutes;
  }, [qc, idleMinutes]);

  // 1. Decide about the sign-in cookie found when the page first loaded. A
  //    sign-in that happens later (after this decision) is a fresh login, so
  //    it just starts the activity clock.
  const decidedRef = useRef(false);
  const wasSignedInRef = useRef(false);
  useEffect(() => {
    if (IS_DEMO_BUILD || !isLoaded) return;
    // After a social/SSO redirect Clerk can report "signed in" a moment before
    // the session object arrives; wait for it rather than guess.
    if (isSignedIn && !session) return;
    if (decidedRef.current) {
      // Only a genuine sign-in (signed out -> signed in) starts the activity
      // clock. Clerk re-emits the session on every token refresh (about once a
      // minute); treating those as activity would keep the idle timer fresh
      // forever.
      if (isSignedIn && !wasSignedInRef.current) markActivity();
      wasSignedInRef.current = Boolean(isSignedIn);
      return;
    }
    wasSignedInRef.current = Boolean(isSignedIn);
    decidedRef.current = true;
    // A sign-in that just happened in this page load (including a redirect
    // back from social/SSO login, which has no stored markers yet) is fresh,
    // not an old cookie.
    const createdAt = session?.createdAt ? new Date(session.createdAt).getTime() : 0;
    // A few seconds of leeway for a clock slightly behind Clerk's; more than
    // that (a session "from the future") must not make an old session look new.
    const age = Date.now() - createdAt;
    const justSignedIn = createdAt > 0 && age > -FRESH_LOGIN_SKEW_MS && age < FRESH_LOGIN_MS;
    // The agency's limit isn't known yet (status loads after first render),
    // so use what the previous visit saved; "reopened" doesn't need it at all.
    if (isSignedIn && !justSignedIn && staleReason(storedIdleMinutes() ?? idleMinutes)) {
      // Nothing is rendered until Clerk confirms the sign-out (retrying if needed).
      void signOutUntilDone().then(() => setChecked(true));
    } else {
      if (isSignedIn) markActivity();
      setChecked(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, session]);

  // 2. While signed in: record activity, watch for idleness, obey the API.
  useEffect(() => {
    if (IS_DEMO_BUILD || !isLoaded || !isSignedIn || !checked) return;

    let lastWrite = 0;
    let lastStatusRefresh = Date.now();
    let lastCallPing = 0;
    const onActivity = (event: Event) => {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_WRITE_EVERY_MS) return;
      lastWrite = now;
      if (isCallInProgress()) {
        markActivity(now);
        return;
      }
      // Activity after the deadline must not erase the idle period, and the
      // very click or keypress that finds the session expired must not reach
      // the page (it could be a submit or delete).
      if (staleReason(minutesNow())) {
        event.stopPropagation();
        void signOutUntilDone();
        return;
      }
      markActivity(now);
    };
    const tick = () => {
      if (expiredDuringCallRef.current && !isCallInProgress()) {
        expiredDuringCallRef.current = false;
        void signOutUntilDone();
        return;
      }
      if (isCallInProgress()) {
        markActivity();
        // Calls never touch the API, and a hidden tab pauses the dashboard
        // poll, so keep the server's idle clock alive for the whole call.
        if (Date.now() - lastCallPing > CALL_HEARTBEAT_EVERY_MS) {
          lastCallPing = Date.now();
          void apiFetch("/api/users/me").catch(() => {});
        }
        return;
      }
      // Reading a document in a frame (contract signing): input happens there.
      if (isUsingEmbeddedDocument(basePath)) {
        markActivity();
        return;
      }
      if (staleReason(minutesNow())) {
        void signOutUntilDone();
        return;
      }
      markSeen();
      // Pick up a changed timeout (Admin > Compliance) in tabs left open.
      if (Date.now() - lastStatusRefresh > REFRESH_STATUS_EVERY_MS) {
        lastStatusRefresh = Date.now();
        void qc.invalidateQueries({ queryKey: ["auth", "status"] });
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onExpired = () => {
      // Dropping a live call helps nobody; end the session as soon as it's over.
      if (isCallInProgress()) {
        expiredDuringCallRef.current = true;
        return;
      }
      void signOutUntilDone();
    };

    // Any request that gets the API's "session expired" answer ends the
    // session, including the few that call fetch directly (AI chat, drafts).
    const originalFetch = window.fetch;
    const guardedFetch: typeof window.fetch = async (...args) => {
      const res = await originalFetch(...args);
      // Only this app's own server speaks for this session.
      if (res.status === 401 && (!res.url || res.url.startsWith(window.location.origin))) {
        void res
          .clone()
          .json()
          .then((b: { code?: string }) => {
            if (b?.code === "SESSION_TIMEOUT") onExpired();
          })
          .catch(() => {});
      }
      return res;
    };
    window.fetch = guardedFetch;

    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    const timer = window.setInterval(tick, CHECK_EVERY_MS);
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.clearInterval(timer);
      if (window.fetch === guardedFetch) window.fetch = originalFetch;
    };
  }, [isLoaded, isSignedIn, checked, signOutUntilDone, minutesNow, qc]);

  if (!IS_DEMO_BUILD && blocked) {
    // No app data is shown; the message avoids a blank page if Clerk is slow.
    return (
      <div role="status" className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base font-medium">Signing you out to keep your information safe…</p>
        <p className="text-sm text-muted-foreground">If this takes more than a few seconds, check your connection.</p>
        <button type="button" className="text-sm underline" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  if (!IS_DEMO_BUILD && isLoaded && isSignedIn && !checked) return null;
  return <>{children}</>;
}
