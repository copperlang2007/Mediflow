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
  const { signOut } = useClerk();
  const qc = useQueryClient();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [checked, setChecked] = useState(false);
  const endingRef = useRef(false);

  const endSession = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    clearSessionMarkers();
    try {
      localStorage.removeItem("mediflow:view-as-org");
    } catch {
      // ignore
    }
    try {
      await signOut({ redirectUrl: `${basePath}/sign-in` });
    } finally {
      qc.clear();
      endingRef.current = false;
    }
  }, [signOut, qc, basePath]);

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
    // The agency's limit isn't known yet (status loads after first render),
    // so use what the previous visit saved; "reopened" doesn't need it at all.
    if (isSignedIn && staleReason(storedIdleMinutes() ?? idleMinutes)) {
      void endSession().finally(() => setChecked(true));
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
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_WRITE_EVERY_MS) return;
      lastWrite = now;
      markActivity(now);
    };
    const tick = () => {
      // The agency's own setting (Admin > Compliance) arrives with /auth/status.
      const status = qc.getQueryData<{ sessionTimeoutMinutes?: number }>(["auth", "status"]);
      if (status?.sessionTimeoutMinutes) saveIdleMinutes(status.sessionTimeoutMinutes);
      const minutes = status?.sessionTimeoutMinutes ?? storedIdleMinutes() ?? idleMinutes;
      if (staleReason(minutes)) void endSession();
      else markSeen();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onExpired = () => void endSession();

    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    const timer = window.setInterval(tick, CHECK_EVERY_MS);
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.clearInterval(timer);
    };
  }, [isLoaded, isSignedIn, checked, idleMinutes, endSession, qc]);

  if (!IS_DEMO_BUILD && isLoaded && isSignedIn && !checked) return null;
  return <>{children}</>;
}
