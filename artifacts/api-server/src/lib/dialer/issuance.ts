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
import type { PgDatabase } from "drizzle-orm/pg-core";
import { db as defaultDb, auditLogTable } from "@workspace/db";
import { logger } from "../logger";
import { signServiceJwt } from "./serviceJwt";
import { runPreclearance } from "./preclearance";

/**
 * Driver-agnostic drizzle handle so the pglite test db and the production
 * node-postgres handle are both assignable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IssuanceDb = PgDatabase<any, any, any>;

/**
 * Machine-readable preclearance failure (Phase 4). Mirrors the shape in
 * `preclearance.ts`; kept structural here to avoid an import cycle on the
 * value side (issuance imports the function, preclearance imports the types).
 */
export interface PreclearanceFailureEntry {
  code: string;
  detail: string;
}

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
  /**
   * Why the call was blocked (Phase 4). Empty / omitted when `precleared`.
   * Never carries PHI — only check codes + human-readable detail.
   */
  failures?: PreclearanceFailureEntry[];
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
  /**
   * Product / plan line for agent-eligibility checks (Phase 4, §2). One of
   * MA | PDP | MAPD | supp | other. Defaults to MAPD (the strictest, AHIP-
   * required line) when omitted. PHI-safe: a product class, never the MBI.
   */
  productLine?: "MA" | "PDP" | "MAPD" | "supp" | "other";
  /** Plan year for AHIP / carrier-cert checks (defaults to the current year). */
  planYear?: number;
  /**
   * Explicit IANA timezone for the callee, when known. When omitted the
   * calling-hours check derives it from `callee.stateCode` (§9).
   */
  calleeTimezone?: string;
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
  /**
   * Override the preclearance decision (tests / custom wiring). When omitted
   * the service runs the REAL Phase-4 preclearance (`runPreclearance`) against
   * MediFlow's licensing/cert/AHIP + consent/DNC/calling-hours data.
   */
  preclear?: (input: IssueTicketInput) => Promise<PreclearanceDecision>;
  /** JWT TTL override (default from serviceJwt). */
  jwtTtlSeconds?: number;
  nowMs?: () => number;
  /**
   * Drizzle handle for the audit-log write (and, when no `preclear` override
   * is supplied, the default preclearance queries). Defaults to the shared
   * `@workspace/db` pool; injectable so pglite integration tests can pass
   * their in-process handle.
   */
  db?: IssuanceDb;
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

  /**
   * Audit a preclearance outcome (§9: every block/issue lands in the audit
   * trail). Best-effort — an audit-write failure must not crash issuance, but
   * is logged. Never carries PHI (no MBI, no transcript) — only the decision
   * and machine-readable failure codes.
   */
  private async auditDecision(
    input: IssueTicketInput,
    decision: PreclearanceDecision,
    dialTicketId: string,
  ): Promise<void> {
    const db = this.config.db ?? defaultDb;
    try {
      await db.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: input.orgId,
        userId: input.agentId,
        userRole: null,
        action: decision.precleared ? "create" : "block",
        resourceType: "dial_preclearance",
        resourceId: decision.preclearanceId,
        changes: {
          dialTicketId,
          contactRef: input.contactRef,
          agentId: input.agentId,
          stateCode: input.callee.stateCode ?? null,
          productLine: input.productLine ?? null,
          precleared: decision.precleared,
          agentEligible: decision.agentEligible,
          tcpaConsentOnFile: decision.tcpaConsentOnFile,
          dncClear: decision.dncClear,
          withinCallingHours: decision.withinCallingHours,
          failures: decision.failures ?? [],
        },
      });
    } catch (err) {
      logger.error(
        { err, dialTicketId, orgId: input.orgId },
        "Dial preclearance: failed to write audit log entry",
      );
    }
  }

  async issueTicket(input: IssueTicketInput): Promise<IssueTicketResult> {
    const nowMs = this.config.nowMs ?? (() => Date.now());
    const dialTicketId = input.dialTicketId ?? randomUUID();

    const decision = await (this.config.preclear
      ? this.config.preclear(input)
      : runPreclearance(input, { db: this.config.db, nowMs }));

    const payload = buildDialTicketPayload(input, decision, dialTicketId);

    // Audit the decision either way — a block AND a successful issue land in
    // the immutable trail (§9, exit criterion: blocked dials are audited).
    await this.auditDecision(input, decision, dialTicketId);

    // If preclearance denies the call, do not contact the dialer at all —
    // MediFlow decides, the dialer enforces (§5/§9).
    if (!decision.precleared) {
      return {
        dialTicketId,
        precleared: false,
        status: 0,
        response: {
          blocked: true,
          preclearanceId: decision.preclearanceId,
          failures: decision.failures ?? [],
        },
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
