import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { IS_DEMO_BUILD } from "@/lib/demo/isDemo";
import {
  DEFAULT_IDLE_MINUTES,
  SESSION_EXPIRED_EVENT,
  clearSessionMarkers,
  markActivity,
  markSeen,
  saveIdleMinutes,
  staleReason,
  storedIdleMinutes,
} from "@/lib/auth/sessionGuard";

const CHECK_EVERY_MS = 15_000;
const FRESH_LOGIN_MS = 2 * 60 * 1000;
const RETRY_SIGN_OUT_MS = 3_000;
const REFRESH_STATUS_EVERY_MS = 5 * 60 * 1000;
const ACTIVITY_WRITE_EVERY_MS = 5_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

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
  const { signOut, session } = useClerk();
  const qc = useQueryClient();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [checked, setChecked] = useState(false);
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
    try {
      await signOut({ redirectUrl: `${basePath}/sign-in` });
      qc.clear();
      return true;
    } catch {
      return false;
    } finally {
      endingRef.current = false;
    }
  }, [signOut, qc, basePath]);

  const minutesNow = useCallback((): number => {
    const status = qc.getQueryData<{ sessionTimeoutMinutes?: number }>(["auth", "status"]);
    if (status?.sessionTimeoutMinutes) saveIdleMinutes(status.sessionTimeoutMinutes);
    return status?.sessionTimeoutMinutes ?? storedIdleMinutes() ?? idleMinutes;
  }, [qc, idleMinutes]);

  // 1. Decide about the sign-in cookie found when the page first loaded. A
  //    sign-in that happens later (after this decision) is a fresh login, so
  //    it just starts the activity clock.
  const decidedRef = useRef(false);
  useEffect(() => {
    if (IS_DEMO_BUILD || !isLoaded) return;
    if (decidedRef.current) {
      if (isSignedIn) markActivity();
      return;
    }
    decidedRef.current = true;
    // A sign-in that just happened in this page load (including a redirect
    // back from social/SSO login, which has no stored markers yet) is fresh,
    // not an old cookie.
    const createdAt = session?.createdAt ? new Date(session.createdAt).getTime() : 0;
    const justSignedIn = createdAt > 0 && Date.now() - createdAt < FRESH_LOGIN_MS;
    // The agency's limit isn't known yet (status loads after first render),
    // so use what the previous visit saved; "reopened" doesn't need it at all.
    if (isSignedIn && !justSignedIn && staleReason(storedIdleMinutes() ?? idleMinutes)) {
      // Stay blocked (nothing rendered) until Clerk confirms the sign-out; if
      // it fails, keep retrying rather than showing a stale user's pages.
      void (async () => {
        while (!(await endSession())) await new Promise((r) => setTimeout(r, RETRY_SIGN_OUT_MS));
        setChecked(true);
      })();
    } else {
      if (isSignedIn) markActivity();
      setChecked(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn]);

  // 2. While signed in: record activity, watch for idleness, obey the API.
  useEffect(() => {
    if (IS_DEMO_BUILD || !isLoaded || !isSignedIn || !checked) return;

    let lastWrite = 0;
    let lastStatusRefresh = Date.now();
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_WRITE_EVERY_MS) return;
      lastWrite = now;
      // Activity after the deadline must not erase the idle period.
      if (staleReason(minutesNow())) {
        void endSession();
        return;
      }
      markActivity(now);
    };
    const tick = () => {
      if (staleReason(minutesNow())) {
        void endSession();
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
    const onExpired = () => void endSession();

    // Any request that gets the API's "session expired" answer ends the
    // session, including the few that call fetch directly (AI chat, drafts).
    const originalFetch = window.fetch;
    const guardedFetch: typeof window.fetch = async (...args) => {
      const res = await originalFetch(...args);
      if (res.status === 401) {
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
  }, [isLoaded, isSignedIn, checked, endSession, minutesNow, qc]);

  if (!IS_DEMO_BUILD && isLoaded && isSignedIn && !checked) return null;
  return <>{children}</>;
}
