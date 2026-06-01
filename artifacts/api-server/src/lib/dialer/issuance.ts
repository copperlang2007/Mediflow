/**
 * Dial-ticket issuance + preclearance service (control-plane client, §5).
 *
 * Responsibilities:
 *   1. Mint a `dialTicketId` (UUID) — the cross-system correlation key (§3).
 *   2. Run a preclearance decision (consent / DNC / calling-hours / agent
 *      eligibility). Phase 2 ships a clean, overridable stub; Phase 4 wires
 *      it to MediFlow's licensing/cert/AHIP + consent/DNC/calling-hours.
 *   3. Sign a short-lived RS256 service JWT (aud `mediflow:dialer:control`,
 *      iss `mediflow`).
 *   4. POST the §5.1 Dial Ticket to the dialer's `POST /dialer/v1/tickets`
 *      with `Authorization: Bearer` + an `Idempotency-Key`.
 *
 * The HTTP client and signing key are INJECTABLE so contract tests run with a
 * mock dialer and an ephemeral keypair — no network, no real keys.
 *
 * The MBI is NEVER placed in the ticket (§3.1).
 */
import { randomUUID } from "crypto";
import { signServiceJwt } from "./serviceJwt";

export interface PreclearanceDecision {
  precleared: boolean;
  preclearedAt: string;
  preclearanceId: string;
  tcpaConsentOnFile: boolean;
  dncClear: boolean;
  withinCallingHours: boolean;
  soaRequired: boolean;
  soaOnFile: boolean;
  agentEligible: boolean;
  expiresAt: string;
}

export interface DialTicketCallee {
  firstName?: string;
  lastName?: string;
  /** E.164. */
  phone: string;
  stateCode?: string;
  zipCode?: string;
  preferredLanguage?: string;
}

export interface DialTicketPayload {
  dialTicketId: string;
  orgId: string;
  agentId: string;
  contactRef: string;
  callee: DialTicketCallee;
  compliance: PreclearanceDecision;
  campaignId?: string;
  callbackUrl: string;
}

export interface IssueTicketInput {
  orgId: string;
  agentId: string;
  contactRef: string;
  callee: DialTicketCallee;
  campaignId?: string;
  callbackUrl: string;
  /** Override the minted id (tests / retries). */
  dialTicketId?: string;
  /** Ticket TTL in seconds (default 30 min). */
  ttlSeconds?: number;
}

/** Minimal fetch-shaped client so tests can inject a mock. */
export type HttpClient = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface IssuanceConfig {
  /** Base URL of the dialer service, e.g. https://dialer.internal */
  dialerBaseUrl: string;
  /** RS256 private key (PEM) used to sign the service JWT. */
  signingPrivateKey: string;
  signingKeyId?: string;
  httpClient: HttpClient;
  /** Override the preclearance decision (Phase 4 wiring / tests). */
  preclear?: (input: IssueTicketInput) => Promise<PreclearanceDecision>;
  /** JWT TTL override (default from serviceJwt). */
  jwtTtlSeconds?: number;
  nowMs?: () => number;
}

export interface IssueTicketResult {
  dialTicketId: string;
  precleared: boolean;
  /** Dialer response status code. */
  status: number;
  response: unknown;
  payload: DialTicketPayload;
}

/**
 * Default Phase-2 preclearance: approves and records an auditable id.
 *
 * TODO(Phase 4): replace with real checks —
 *   - consent ledger + DNC (MediFlow truth, §9)
 *   - DST-correct calling-hours per callee timezone (§9)
 *   - agent licensing/cert/AHIP eligibility for state+product (§2)
 * On any failure the ticket must NOT be issued and the block is audited.
 */
async function defaultPreclear(
  input: IssueTicketInput,
  nowMs: () => number,
  ttlSeconds: number,
): Promise<PreclearanceDecision> {
  const now = new Date(nowMs());
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  return {
    precleared: true,
    preclearedAt: now.toISOString(),
    preclearanceId: `pc_${randomUUID()}`,
    tcpaConsentOnFile: true,
    dncClear: true,
    withinCallingHours: true,
    soaRequired: true,
    soaOnFile: false,
    agentEligible: true,
    expiresAt: expires.toISOString(),
  };
}

/**
 * Build the §5.1 Dial Ticket payload. Exposed for tests and so the route
 * layer can assert "no MBI" before send. Carries ONLY the minimal callee
 * subset — never the MBI (§3.1).
 */
export function buildDialTicketPayload(
  input: IssueTicketInput,
  decision: PreclearanceDecision,
  dialTicketId: string,
): DialTicketPayload {
  return {
    dialTicketId,
    orgId: input.orgId,
    agentId: input.agentId,
    contactRef: input.contactRef,
    callee: {
      firstName: input.callee.firstName,
      lastName: input.callee.lastName,
      phone: input.callee.phone,
      stateCode: input.callee.stateCode,
      zipCode: input.callee.zipCode,
      preferredLanguage: input.callee.preferredLanguage,
    },
    compliance: decision,
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    callbackUrl: input.callbackUrl,
  };
}

export class DialerIssuanceService {
  constructor(private readonly config: IssuanceConfig) {}

  async issueTicket(input: IssueTicketInput): Promise<IssueTicketResult> {
    const nowMs = this.config.nowMs ?? (() => Date.now());
    const ttlSeconds = input.ttlSeconds ?? 30 * 60;
    const dialTicketId = input.dialTicketId ?? randomUUID();

    const decision = await (this.config.preclear
      ? this.config.preclear(input)
      : defaultPreclear(input, nowMs, ttlSeconds));

    const payload = buildDialTicketPayload(input, decision, dialTicketId);

    // If preclearance denies the call, do not contact the dialer at all —
    // MediFlow decides, the dialer enforces (§5/§9).
    if (!decision.precleared) {
      return {
        dialTicketId,
        precleared: false,
        status: 0,
        response: { blocked: true, preclearanceId: decision.preclearanceId },
        payload,
      };
    }

    const jwt = signServiceJwt({
      privateKey: this.config.signingPrivateKey,
      keyId: this.config.signingKeyId,
      subject: input.agentId,
      ttlSeconds: this.config.jwtTtlSeconds,
      nowSeconds: Math.floor(nowMs() / 1000),
      additionalClaims: { dialTicketId, orgId: input.orgId },
    });

    const url = `${this.config.dialerBaseUrl.replace(/\/+$/, "")}/dialer/v1/tickets`;
    const res = await this.config.httpClient(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        // dedupe across retries (§6.2) — keyed on the correlation id.
        "Idempotency-Key": dialTicketId,
      },
      body: JSON.stringify(payload),
    });

    const response = await res.json().catch(() => null);
    return {
      dialTicketId,
      precleared: true,
      status: res.status,
      response,
      payload,
    };
  }
}

/** Adapts global `fetch` to the injectable `HttpClient` shape. */
export const fetchHttpClient: HttpClient = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: () => res.json() };
};
