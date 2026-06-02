/**
 * Control-plane READ client — `GET /dialer/v1/calls/{dialerCallId}` (spec §5.4).
 *
 * Read-only status fetch MediFlow uses to reconcile a dial ticket when the
 * terminal lifecycle webhook (`call.completed` / `call.failed`) was missed
 * (§6.2: consumers must tolerate dropped/duplicate delivery). The Phase-6
 * reconciliation job (`workers/dialerReconcile.ts`) is the only caller today.
 *
 * Auth mirrors issuance (§4.1, §5): a short-lived RS256 service JWT
 * (aud `mediflow:dialer:control`, iss `mediflow`). The HTTP client, signing
 * key and clock are INJECTABLE so the reconciliation tests run against a mock
 * dialer with an ephemeral keypair — no network, no real keys.
 */
import { signServiceJwt } from "./serviceJwt";

/**
 * Minimal fetch-shaped client so tests can inject a mock. Mirrors issuance's
 * `HttpClient` but for a GET (no body).
 */
export type ReadHttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * Authoritative call state returned by the dialer (§5.4). The dialer reports a
 * lifecycle `status` and, for a terminal call, the same fields the terminal
 * webhook would carry. Parsed leniently (forward-compat, §6.2): unknown fields
 * are ignored, missing optional fields tolerated.
 */
export interface DialerCallState {
  dialerCallId?: string;
  /**
   * Dialer-side lifecycle status. The dialer's own vocabulary
   * (QUEUED | INITIATED | RINGING | IN_PROGRESS | COMPLETED | FAILED | …);
   * `mapDialerStatusToOutcome` reduces it to a MediFlow terminal outcome.
   */
  status?: string;
  /** Terminal-call detail (mirrors `call.completed` data). */
  duration?: number;
  endedReason?: string;
  /** Terminal-failure detail (mirrors `call.failed` data). */
  reason?: string;
  /** Spot-audit hook (§6.1): whether the dialer still holds the transcript. */
  transcriptRetained?: boolean;
}

export interface ReadClientConfig {
  /** Base URL of the dialer service, e.g. https://dialer.internal */
  dialerBaseUrl: string;
  /** RS256 private key (PEM) used to sign the service JWT. */
  signingPrivateKey: string;
  signingKeyId?: string;
  httpClient: ReadHttpClient;
  /** JWT TTL override (default from serviceJwt). */
  jwtTtlSeconds?: number;
  nowMs?: () => number;
}

export type FetchCallStateResult =
  | { ok: true; status: number; state: DialerCallState }
  | { ok: false; status: number; reason: "not_found" | "error" };

/**
 * The reduced terminal outcome MediFlow applies to a ticket. `null` means the
 * call is NOT terminal yet (still ringing / in progress) — the reconciler
 * leaves the ticket alone and tries again on the next sweep.
 */
export type TerminalOutcome =
  | { terminal: true; status: "COMPLETED" | "FAILED"; eventType: "call.completed" | "call.failed" }
  | { terminal: false };

const TERMINAL_COMPLETED = new Set(["COMPLETED", "COMPLETE", "DONE", "ENDED"]);
const TERMINAL_FAILED = new Set([
  "FAILED",
  "FAILURE",
  "NO_ANSWER",
  "BUSY",
  "VOICEMAIL",
  "CANCELED",
  "CANCELLED",
]);

/**
 * Reduce the dialer's lifecycle status to a MediFlow terminal outcome. Anything
 * not recognised as terminal (or unknown) is treated as non-terminal so the
 * reconciler never prematurely closes a still-active call.
 */
export function mapDialerStatusToOutcome(status: string | undefined): TerminalOutcome {
  if (!status) return { terminal: false };
  const s = status.trim().toUpperCase();
  if (TERMINAL_COMPLETED.has(s)) {
    return { terminal: true, status: "COMPLETED", eventType: "call.completed" };
  }
  if (TERMINAL_FAILED.has(s)) {
    return { terminal: true, status: "FAILED", eventType: "call.failed" };
  }
  return { terminal: false };
}

export class DialerReadClient {
  constructor(private readonly config: ReadClientConfig) {}

  /**
   * GET the authoritative state for a dialer call. A `404` becomes a typed
   * `not_found` (the dialer never knew this call — e.g. the ticket was issued
   * but the call never started); any other non-2xx is `error` (transient — the
   * job retries on the next sweep). A 2xx returns the parsed state.
   */
  async fetchCallState(dialerCallId: string): Promise<FetchCallStateResult> {
    const nowMs = this.config.nowMs ?? (() => Date.now());
    const jwt = signServiceJwt({
      privateKey: this.config.signingPrivateKey,
      keyId: this.config.signingKeyId,
      ttlSeconds: this.config.jwtTtlSeconds,
      nowSeconds: Math.floor(nowMs() / 1000),
    });

    const base = this.config.dialerBaseUrl.replace(/\/+$/, "");
    const url = `${base}/dialer/v1/calls/${encodeURIComponent(dialerCallId)}`;
    const res = await this.config.httpClient(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (res.status === 404) {
      return { ok: false, status: 404, reason: "not_found" };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, reason: "error" };
    }
    const body = (await res.json().catch(() => null)) as DialerCallState | null;
    return { ok: true, status: res.status, state: body ?? {} };
  }
}

/** Adapts global `fetch` to the injectable `ReadHttpClient` shape. */
export const fetchReadHttpClient: ReadHttpClient = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: () => res.json() };
};
