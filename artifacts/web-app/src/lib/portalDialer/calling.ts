/**
 * Native browser calling for the softphone (Twilio Voice).
 *
 * Flow: Call -> POST /softphone/calls (server preclears and derives the number
 * from the CONTACT — the browser never sends one) -> Device from
 * GET /softphone/voice-token -> device.connect({ callSessionId, To }) ->
 * mute / hang up / live timer -> disposition + notes (PATCH).
 *
 * Honest states, never simulated: `needs_setup` (token 503), `demo` (demo
 * build — no calls, and no SDK is even loaded), `blocked` (with the server's
 * exact reasons). The Twilio SDK is imported lazily so it only downloads when
 * someone actually places a call.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CallBlockedResponse,
  CallBlockReason,
  StartCallResponse,
  UpdateCallResponse,
  VoiceToken,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { IS_DEMO_BUILD } from "@/lib/demo/isDemo";
import { setCallInProgress } from "@/lib/auth/sessionGuard";

/** Roles the API grants `call:create` (lib/permissions.ts). UX only — the API enforces it. */
export const CALL_CREATE_ROLES = ["super_admin", "agency_admin", "agent_support", "agent"] as const;

// ---- Readiness -------------------------------------------------------------

export type VoiceReadiness =
  | { state: "checking" }
  | { state: "demo" }
  | { state: "needs_setup"; missing: string[] }
  | { state: "ready"; token: VoiceToken }
  | { state: "error"; message: string };

interface HttpError extends Error {
  status?: number;
  data?: unknown;
}

export const VOICE_TOKEN_KEY = ["/api/softphone/voice-token"] as const;

/**
 * Whether calling can work right now. The token endpoint is the source of
 * truth: 503 needs_setup means the Twilio env is not configured. Skipped
 * entirely (no request) in demo builds.
 */
export function useVoiceReadiness(enabled: boolean): VoiceReadiness {
  const q = useQuery({
    queryKey: VOICE_TOKEN_KEY,
    enabled: enabled && !IS_DEMO_BUILD,
    retry: false,
    // Tokens live 10 minutes; keep one fresh without minting on every render.
    staleTime: 8 * 60_000,
    refetchInterval: 8 * 60_000,
    queryFn: async ({ signal }): Promise<VoiceReadiness> => {
      try {
        const token = await apiFetch<VoiceToken>("/api/softphone/voice-token", { signal });
        return { state: "ready", token };
      } catch (err) {
        const e = err as HttpError;
        const body = (e.data ?? {}) as { status?: string; missing?: string[] };
        if (e.status === 503 && body.status === "needs_setup") {
          return { state: "needs_setup", missing: body.missing ?? [] };
        }
        if (e.status === 503 && body.status === "demo_mode") return { state: "demo" };
        return { state: "error", message: e.message || "Couldn't check calling setup" };
      }
    },
  });
  if (IS_DEMO_BUILD) return { state: "demo" };
  if (!enabled || q.isLoading || !q.data) return { state: "checking" };
  return q.data;
}

// ---- Call state machine ----------------------------------------------------

export type CallPhase = "idle" | "checking" | "connecting" | "ringing" | "in_call" | "ended";

export interface CallState {
  phase: CallPhase;
  callSessionId: string | null;
  contactId: string | null;
  /** Display name of the contact this call was placed to, captured at Call time. */
  contactName: string | null;
  muted: boolean;
  /** True once the far end picked up (drives what the post-call form may offer). */
  answered: boolean;
  /** ms epoch when the far end answered; drives the live timer. */
  answeredAt: number | null;
  /** Set when the call ended, for the post-call form. */
  endedAt: number | null;
  /** Server's exact refusal reasons (HTTP 409). */
  blocked: CallBlockReason[] | null;
  /** Which consent rule allowed this call (server-reported); null when unknown. */
  consentBasis: string | null;
  /** Non-refusal problem to show (mic denied, network, …). */
  error: string | null;
  /** Server said calling needs setup / is unavailable mid-flow. */
  unavailable: "needs_setup" | "demo" | null;
}

const IDLE: CallState = {
  phase: "idle",
  callSessionId: null,
  contactId: null,
  contactName: null,
  muted: false,
  answered: false,
  answeredAt: null,
  endedAt: null,
  blocked: null,
  consentBasis: null,
  error: null,
  unavailable: null,
};

/** Minimal shape of the Twilio Call we use — lets tests inject a fake SDK. */
export interface VoiceCallLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  mute(shouldMute?: boolean): void;
  disconnect(): void;
}
export interface VoiceDeviceLike {
  connect(opts: { params: Record<string, string> }): Promise<VoiceCallLike>;
  updateToken(token: string): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  destroy(): void;
}
export type DeviceFactory = (token: string) => Promise<VoiceDeviceLike>;

const defaultDeviceFactory: DeviceFactory = async (token) => {
  const { Device, Call } = await import("@twilio/voice-sdk");
  return new Device(token, {
    codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
    closeProtection: true,
  }) as unknown as VoiceDeviceLike;
};

function micMessage(err: unknown): string | null {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Microphone access is blocked. Allow the microphone for this site in your browser, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Plug one in or choose one in your browser settings.";
  }
  return null;
}

/**
 * Tell the server an attempt never reached Twilio, so it stops counting toward
 * the attempt limit / redial cooldown. Best effort: failures are ignored (the
 * server also stops counting unclaimed sessions once they expire).
 */
export function cancelCallSession(callSessionId: string): Promise<unknown> {
  return apiFetch(`/api/softphone/calls/${encodeURIComponent(callSessionId)}/cancel`, { method: "POST" });
}
function abandonSession(callSessionId: string): void {
  void cancelCallSession(callSessionId).catch(() => undefined);
}

export function useSoftphoneCall(opts: { deviceFactory?: DeviceFactory } = {}) {
  const factory = opts.deviceFactory ?? defaultDeviceFactory;
  const [state, setState] = useState<CallState>(IDLE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const deviceRef = useRef<VoiceDeviceLike | null>(null);
  const callRef = useRef<VoiceCallLike | null>(null);
  const tokenExpiryRef = useRef(0);
  // Attempt generation. Every await in `start` re-checks it; hang-up during
  // connecting, reset and unmount bump it, so a late Device / call from an
  // abandoned attempt is torn down instead of going live.
  const genRef = useRef(0);

  // Tell the session guard a call is live so it never counts as idle time.
  useEffect(() => {
    // Not "connecting": that can sit on a microphone prompt indefinitely.
    setCallInProgress(state.phase === "ringing" || state.phase === "in_call");
    return () => setCallInProgress(false);
  }, [state.phase]);

  const patch = useCallback((p: Partial<CallState>) => setState((s) => ({ ...s, ...p })), []);

  const teardown = useCallback(() => {
    try { callRef.current?.disconnect(); } catch { /* already gone */ }
    callRef.current = null;
    try { deviceRef.current?.destroy(); } catch { /* already gone */ }
    deviceRef.current = null;
  }, []);

  // Never leave a call or a registered Device behind when the page unmounts.
  useEffect(
    () => () => {
      genRef.current += 1;
      teardown();
    },
    [teardown],
  );

  const fetchToken = useCallback(async (): Promise<VoiceToken> => {
    const t = await apiFetch<VoiceToken>("/api/softphone/voice-token");
    tokenExpiryRef.current = new Date(t.expiresAt).getTime();
    return t;
  }, []);

  const start = useCallback(
    async (contactId: string, contactName: string) => {
      if (IS_DEMO_BUILD) {
        setState({ ...IDLE, unavailable: "demo" });
        return;
      }
      const gen = ++genRef.current;
      const stale = (): boolean => genRef.current !== gen;
      setState({ ...IDLE, phase: "checking", contactId, contactName });

      // 1) Server-side preclearance. It picks the number; we only name a contact.
      let session: StartCallResponse;
      try {
        session = await apiFetch<StartCallResponse>("/api/softphone/calls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId }),
        });
      } catch (err) {
        if (stale()) return;
        const e = err as HttpError;
        const body = (e.data ?? {}) as Partial<CallBlockedResponse> & { status?: string };
        const base = { ...IDLE, contactId, contactName };
        if (e.status === 409 && Array.isArray(body.reasons)) {
          setState({ ...base, blocked: body.reasons });
        } else if (e.status === 503 && body.status === "needs_setup") {
          setState({ ...base, unavailable: "needs_setup" });
        } else if (e.status === 503 && body.status === "demo_mode") {
          setState({ ...base, unavailable: "demo" });
        } else if (e.status === 404) {
          setState({ ...base, error: "This contact can't be called from your account." });
        } else {
          setState({ ...base, error: e.message || "Couldn't start the call." });
        }
        return;
      }
      // Reset while the request was in flight: the session is simply never dialed.
      if (stale()) {
        abandonSession(session.callSessionId);
        return;
      }

      patch({ phase: "connecting", callSessionId: session.callSessionId, consentBasis: session.consentBasis ?? null });

      // 2) A Device from a fresh access token, 3) connect with the session id.
      try {
        if (!deviceRef.current || tokenExpiryRef.current - Date.now() < 60_000) {
          const token = await fetchToken();
          if (stale()) {
            abandonSession(session.callSessionId);
            return;
          }
          if (deviceRef.current) {
            deviceRef.current.updateToken(token.token);
          } else {
            const device = await factory(token.token);
            if (stale()) {
              // Abandoned while the Device was being created: never let it live.
              try { device.destroy(); } catch { /* already gone */ }
              abandonSession(session.callSessionId);
              return;
            }
            device.on("tokenWillExpire", () => {
              void fetchToken().then((t) => deviceRef.current?.updateToken(t.token)).catch(() => undefined);
            });
            deviceRef.current = device;
          }
        }
        const call = await deviceRef.current!.connect({
          params: { callSessionId: session.callSessionId, To: session.to },
        });
        if (stale()) {
          // Abandoned while connecting: hang the late call up and drop the Device.
          try { call.disconnect(); } catch { /* already gone */ }
          teardown();
          abandonSession(session.callSessionId);
          return;
        }
        callRef.current = call;
        call.on("ringing", () => patch({ phase: "ringing" }));
        call.on("accept", () => patch({ phase: "in_call", answered: true, answeredAt: Date.now() }));
        call.on("mute", (isMuted: unknown) => patch({ muted: Boolean(isMuted) }));
        const finish = (message?: string) => {
          callRef.current = null;
          setState((s) =>
            s.phase === "ended" ? s : { ...s, phase: "ended", endedAt: Date.now(), muted: false, error: message ?? s.error },
          );
        };
        call.on("disconnect", () => finish());
        call.on("cancel", () => finish());
        call.on("reject", () => finish("The call was rejected before it connected."));
        call.on("error", (e: unknown) =>
          finish(micMessage(e) ?? ((e as { message?: string })?.message || "The call ended with an error.")),
        );
        patch({ phase: "ringing" });
      } catch (err) {
        // Never reached Twilio: free the retry slot so an ordinary retry works.
        abandonSession(session.callSessionId);
        if (stale()) return;
        const e = err as HttpError;
        const body = (e.data ?? {}) as { status?: string };
        if (e.status === 503 && body.status === "needs_setup") {
          setState({ ...IDLE, contactId, contactName, callSessionId: session.callSessionId, unavailable: "needs_setup" });
        } else {
          // The session exists but never dialed; the disposition form still lets the agent record why.
          setState((s) => ({
            ...s,
            phase: "ended",
            endedAt: Date.now(),
            error: micMessage(err) ?? (e.message || "Couldn't connect the call."),
          }));
        }
      }
    },
    [factory, fetchToken, patch, teardown],
  );

  const hangUp = useCallback(() => {
    if (callRef.current) {
      try { callRef.current.disconnect(); } catch { /* ignore */ }
      return;
    }
    // No live call yet (still connecting): abandon the attempt. Bumping the
    // generation makes `start` destroy any Device / call that arrives late.
    genRef.current += 1;
    teardown();
    if (stateRef.current.phase === "connecting" && stateRef.current.callSessionId) {
      abandonSession(stateRef.current.callSessionId);
    }
    setState((s) =>
      s.phase === "connecting"
        ? { ...s, phase: "ended", endedAt: Date.now(), muted: false, error: "You hung up before the call connected." }
        : s,
    );
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    setState((s) => {
      const next = !s.muted;
      try { call.mute(next); } catch { /* ignore */ }
      return { ...s, muted: next };
    });
  }, []);

  /** Back to idle (after the post-call form is saved or skipped). */
  const reset = useCallback(() => {
    genRef.current += 1;
    teardown();
    setState(IDLE);
  }, [teardown]);

  return { state, start, hangUp, toggleMute, reset };
}

// ---- Post-call disposition -------------------------------------------------

export function saveCallDisposition(
  callSessionId: string,
  body: { dispositionCode?: string; notes?: string | null },
): Promise<UpdateCallResponse> {
  return apiFetch<UpdateCallResponse>(`/api/softphone/calls/${encodeURIComponent(callSessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
