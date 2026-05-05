/**
 * useSSENotifications
 *
 * Opens a persistent Server-Sent Events connection to /api/notifications/stream
 * and maintains a live unread notification count.
 *
 * Falls back gracefully:
 *  - If SSE is unavailable (network, auth) the count stays at its last value.
 *  - Exponential backoff on reconnect (max 30s).
 *  - Closes the connection on unmount.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@clerk/react";

interface NotificationEvent {
  type: "notification" | "unread_count";
  unread?: number;
  id?: string;
}

interface UseSSENotificationsReturn {
  unreadCount: number;
  setUnreadCount: (count: number) => void;
  connected: boolean;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const SSE_PATH = `${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/notifications/stream`;

export function useSSENotifications(
  initialCount = 0,
): UseSSENotificationsReturn {
  const { getToken, isSignedIn } = useAuth();
  const [unreadCount, setUnreadCount] = useState(initialCount);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(BASE_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const connect = useCallback(async () => {
    if (unmountedRef.current || !isSignedIn) return;

    // SSE can't set headers directly — we rely on Clerk's session cookie
    // which is automatically sent with same-origin requests.
    const url = SSE_PATH;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

    es.onopen = () => {
      if (unmountedRef.current) return;
      setConnected(true);
      backoffRef.current = BASE_BACKOFF_MS;
    };

    es.addEventListener("message", (event: MessageEvent<string>) => {
      if (unmountedRef.current) return;
      try {
        const data = JSON.parse(event.data) as NotificationEvent;
        if (data.type === "unread_count" && typeof data.unread === "number") {
          setUnreadCount(data.unread);
        } else if (data.type === "notification") {
          setUnreadCount((prev) => prev + 1);
        }
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      if (unmountedRef.current) return;
      setConnected(false);
      es.close();
      esRef.current = null;

      // Exponential backoff reconnect
      const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
      backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);

      reconnectTimerRef.current = setTimeout(() => {
        if (!unmountedRef.current) connect();
      }, delay);
    };
  }, [isSignedIn]);

  useEffect(() => {
    unmountedRef.current = false;
    if (isSignedIn) connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [isSignedIn, connect]);

  return { unreadCount, setUnreadCount, connected };
}
