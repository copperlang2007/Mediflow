/**
 * Agent presence heartbeat.
 *
 * Drives the "available right now" half of the inbound lead queue. The
 * ready-to-sell router intersects the eligible pool with agents who are
 * currently `available` (see docs/inbound-lead-queue.md); that `available`
 * state is set ONLY by this heartbeat. The server enforces a read-time TTL
 * (default 90s), so the client must re-ping comfortably inside it.
 *
 * Behaviour:
 *   - When enabled and `available`, POST a heartbeat immediately and then on a
 *     fixed interval well inside the TTL.
 *   - Going `away` posts a single `away` and stops pinging (the agent drops out
 *     of the routable pool; the row expires to offline on its own).
 *   - Coming back posts `available` and restarts the interval.
 *   - A 404 means no agent record is linked to this user (e.g. an admin who
 *     isn't an agent). We surface `linked: false` so the UI can hide the
 *     control rather than show a broken toggle.
 *
 * This is a fire-and-forget side effect with a timer, so it is intentionally
 * plain useState/useEffect rather than react-query.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";

/** Re-ping cadence — half the server's default 90s TTL, so a single missed
 * ping never drops the agent from the pool. */
export const HEARTBEAT_INTERVAL_MS = 45_000;

export type PresenceUiStatus = "available" | "away";

interface HeartbeatResponse {
  agentId: string;
  status: string;
  expiresAt: string | null;
}

export interface UsePresenceHeartbeat {
  /** The agent's current self-reported status. */
  status: PresenceUiStatus;
  /** False once a heartbeat 404s — this user has no linked agent record. */
  linked: boolean;
  /** True while a heartbeat request is in flight. */
  syncing: boolean;
  /** Flip to available (rejoin the pool) / away (leave it). */
  setStatus: (next: PresenceUiStatus) => void;
}

async function postHeartbeat(
  status: PresenceUiStatus | "offline",
): Promise<HeartbeatResponse> {
  return apiRequest<HeartbeatResponse>("/api/queue/presence/heartbeat", {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function usePresenceHeartbeat(
  enabled: boolean,
): UsePresenceHeartbeat {
  const [status, setStatusState] = useState<PresenceUiStatus>("available");
  const [linked, setLinked] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Latest status without re-arming the interval effect on every change.
  const statusRef = useRef<PresenceUiStatus>(status);
  statusRef.current = status;

  const send = useCallback(async (next: PresenceUiStatus | "offline") => {
    setSyncing(true);
    try {
      await postHeartbeat(next);
      setLinked(true);
    } catch (err) {
      // 404 = this user has no agent record; stop trying and let the UI hide.
      if ((err as { status?: number }).status === 404) setLinked(false);
    } finally {
      setSyncing(false);
    }
  }, []);

  const setStatus = useCallback(
    (next: PresenceUiStatus) => {
      setStatusState(next);
      // Going available is handled by the ping effect's immediate send (which
      // also covers mount), so only send here for transitions the effect won't
      // act on — i.e. leaving the pool. This avoids a duplicate heartbeat.
      if (next !== "available") void send(next);
    },
    [send],
  );

  // Ping loop: active only while enabled, linked, and available. Re-pings on a
  // fixed cadence inside the TTL; tears down when any precondition flips.
  useEffect(() => {
    if (!enabled || !linked || status !== "available") return;
    void send("available");
    const id = setInterval(() => {
      if (statusRef.current === "available") void send("available");
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, linked, status, send]);

  return { status, linked, syncing, setStatus };
}
