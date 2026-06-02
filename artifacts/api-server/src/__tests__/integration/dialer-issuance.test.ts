/**
 * Contract test — dial-ticket issuance + preclearance against a MOCK dialer
 * (spec §5). Verifies the outbound request the control-plane client makes:
 *   - POST to /dialer/v1/tickets
 *   - Authorization: Bearer <RS256 service JWT> verifiable with the public key,
 *     aud `mediflow:dialer:control`, iss `mediflow`
 *   - Idempotency-Key present and == dialTicketId
 *   - §5.1 payload shape, and CRUCIALLY no MBI anywhere in the body
 *
 * No network, no real keys: an ephemeral keypair is generated in-process and
 * the HTTP client is injected.
 */
import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

// issuance.ts statically imports `@workspace/db`, whose module-load guard
// requires DATABASE_URL. These contract tests inject their own db and never
// query the real pool (the pg Pool connects lazily), so a dummy URL is enough
// to satisfy the guard. `vi.hoisted` runs before the static imports below.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
});

import {
  DialerIssuanceService,
  type HttpClient,
  type IssueTicketInput,
} from "../../lib/dialer/issuance";
import {
  verifyServiceJwt,
  DIALER_CONTROL_AUDIENCE,
  SERVICE_JWT_ISSUER,
} from "../../lib/dialer/serviceJwt";

function makeKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockDialer(captured: Captured[]): HttpClient {
  return async (url, init) => {
    captured.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      status: 201,
      json: async () => ({ dialerTicketId: "dlr_123", status: "QUEUED" }),
    };
  };
}

/**
 * An approving preclearance override. These contract tests exercise the JWT /
 * HTTP wire contract, not the Phase-4 preclearance checks (those have their
 * own pglite-backed suite in dialer-preclearance.test.ts), so we inject a
 * deterministic "approve" decision rather than touching a database.
 */
/** A no-op db whose audit-log insert resolves without touching Postgres. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopDb: any = {
  insert: () => ({ values: async () => undefined }),
};

const approvePreclear = async (): Promise<
  import("../../lib/dialer/issuance").PreclearanceDecision
> => ({
  precleared: true,
  preclearedAt: new Date().toISOString(),
  preclearanceId: `pc_${crypto.randomUUID()}`,
  tcpaConsentOnFile: true,
  dncClear: true,
  withinCallingHours: true,
  soaRequired: true,
  soaOnFile: false,
  agentEligible: true,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const baseInput: IssueTicketInput = {
  orgId: "org_2abc",
  agentId: "agt_2def",
  contactRef: "con_2ghi",
  callee: {
    firstName: "Jane",
    lastName: "Doe",
    phone: "+15035551234",
    stateCode: "OR",
    zipCode: "97201",
    preferredLanguage: "en",
  },
  campaignId: "cmp_1",
  callbackUrl: "https://app.mediflow.test/api/dialer/v1/events",
};

describe("Dial-ticket issuance → mock dialer", () => {
  it("posts a correctly-signed, MBI-free ticket to /dialer/v1/tickets", async () => {
    const { privateKey, publicKey } = makeKeypair();
    const captured: Captured[] = [];
    const svc = new DialerIssuanceService({
      dialerBaseUrl: "https://dialer.internal/",
      signingPrivateKey: privateKey,
      signingKeyId: "key-1",
      httpClient: mockDialer(captured),
      preclear: approvePreclear,
      db: noopDb,
    });

    const result = await svc.issueTicket(baseInput);

    expect(result.precleared).toBe(true);
    expect(result.status).toBe(201);
    expect(result.dialTicketId).toMatch(/[0-9a-f-]{36}/);

    expect(captured).toHaveLength(1);
    const req = captured[0];

    // Endpoint + method.
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://dialer.internal/dialer/v1/tickets");

    // Idempotency-Key present and tied to the correlation id.
    expect(req.headers["Idempotency-Key"]).toBe(result.dialTicketId);

    // Authorization is a verifiable RS256 service JWT with the right aud/iss.
    const auth = req.headers["Authorization"];
    expect(auth.startsWith("Bearer ")).toBe(true);
    const token = auth.slice("Bearer ".length);
    const verified = verifyServiceJwt({ token, publicKey });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.aud).toBe(DIALER_CONTROL_AUDIENCE);
      expect(verified.claims.iss).toBe(SERVICE_JWT_ISSUER);
      expect(verified.claims.dialTicketId).toBe(result.dialTicketId);
      expect(verified.claims.orgId).toBe(baseInput.orgId);
    }

    // Payload shape (§5.1).
    const payload = JSON.parse(req.body);
    expect(payload.dialTicketId).toBe(result.dialTicketId);
    expect(payload.orgId).toBe("org_2abc");
    expect(payload.callee.phone).toBe("+15035551234");
    expect(payload.compliance.precleared).toBe(true);
    expect(payload.compliance.preclearanceId).toBeTruthy();
    expect(payload.callbackUrl).toContain("/api/dialer/v1/events");

    // PHI minimization (§3.1): no MBI anywhere in the serialized request.
    const haystack = JSON.stringify(payload).toLowerCase();
    expect(haystack).not.toContain("medicare");
    expect(haystack).not.toContain("mbi");
    expect(payload.callee).not.toHaveProperty("medicareId");
  });

  it("rejects a JWT signed with the wrong key (mock dialer would 401)", async () => {
    const signer = makeKeypair();
    const attacker = makeKeypair();
    const captured: Captured[] = [];
    const svc = new DialerIssuanceService({
      dialerBaseUrl: "https://dialer.internal",
      signingPrivateKey: signer.privateKey,
      httpClient: mockDialer(captured),
      preclear: approvePreclear,
      db: noopDb,
    });
    await svc.issueTicket(baseInput);
    const token = captured[0].headers["Authorization"].slice("Bearer ".length);
    // Verifying with the WRONG public key must fail.
    const verified = verifyServiceJwt({ token, publicKey: attacker.publicKey });
    expect(verified.ok).toBe(false);
  });

  it("does NOT contact the dialer when preclearance denies the call", async () => {
    const { privateKey } = makeKeypair();
    const captured: Captured[] = [];
    const svc = new DialerIssuanceService({
      dialerBaseUrl: "https://dialer.internal",
      signingPrivateKey: privateKey,
      httpClient: mockDialer(captured),
      db: noopDb,
      preclear: async () => ({
        precleared: false,
        preclearedAt: new Date().toISOString(),
        preclearanceId: "pc_denied",
        tcpaConsentOnFile: false,
        dncClear: false,
        withinCallingHours: true,
        soaRequired: true,
        soaOnFile: false,
        agentEligible: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });

    const result = await svc.issueTicket(baseInput);
    expect(result.precleared).toBe(false);
    expect(captured).toHaveLength(0); // no outbound call
  });
});
