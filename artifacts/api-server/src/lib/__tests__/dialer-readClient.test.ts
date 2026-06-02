/**
 * Unit tests — control-plane read client (spec §5.4).
 *
 * Covers the wire contract of `GET /dialer/v1/calls/{id}` and the
 * dialer-status → terminal-outcome reduction, without a database or network
 * (the HTTP client is injected, keys are ephemeral).
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  DialerReadClient,
  mapDialerStatusToOutcome,
  type ReadHttpClient,
} from "../dialer/readClient";
import {
  verifyServiceJwt,
  DIALER_CONTROL_AUDIENCE,
  SERVICE_JWT_ISSUER,
} from "../dialer/serviceJwt";

function makeKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

describe("mapDialerStatusToOutcome", () => {
  it("maps completed-family statuses to COMPLETED", () => {
    for (const s of ["COMPLETED", "complete", "Done", "ended"]) {
      expect(mapDialerStatusToOutcome(s)).toEqual({
        terminal: true,
        status: "COMPLETED",
        eventType: "call.completed",
      });
    }
  });

  it("maps failure-family statuses to FAILED", () => {
    for (const s of ["FAILED", "no_answer", "BUSY", "voicemail", "canceled"]) {
      expect(mapDialerStatusToOutcome(s)).toEqual({
        terminal: true,
        status: "FAILED",
        eventType: "call.failed",
      });
    }
  });

  it("treats in-flight / unknown / missing status as non-terminal", () => {
    for (const s of ["RINGING", "IN_PROGRESS", "QUEUED", "weird", undefined]) {
      expect(mapDialerStatusToOutcome(s)).toEqual({ terminal: false });
    }
  });
});

describe("DialerReadClient.fetchCallState", () => {
  it("GETs /dialer/v1/calls/{id} with a verifiable service JWT", async () => {
    const { privateKey, publicKey } = makeKeypair();
    let captured: { url: string; method: string; auth: string } | null = null;
    const httpClient: ReadHttpClient = async (url, init) => {
      captured = {
        url,
        method: init.method,
        auth: init.headers["Authorization"],
      };
      return { status: 200, json: async () => ({ status: "COMPLETED", duration: 12 }) };
    };
    const client = new DialerReadClient({
      dialerBaseUrl: "https://dialer.internal/",
      signingPrivateKey: privateKey,
      httpClient,
    });

    const res = await client.fetchCallState("call_abc");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.status).toBe("COMPLETED");
      expect(res.state.duration).toBe(12);
    }
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("GET");
    expect(captured!.url).toBe("https://dialer.internal/dialer/v1/calls/call_abc");

    const token = captured!.auth.slice("Bearer ".length);
    const verified = verifyServiceJwt({ token, publicKey });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.aud).toBe(DIALER_CONTROL_AUDIENCE);
      expect(verified.claims.iss).toBe(SERVICE_JWT_ISSUER);
    }
  });

  it("maps a 404 to not_found", async () => {
    const { privateKey } = makeKeypair();
    const client = new DialerReadClient({
      dialerBaseUrl: "https://dialer.internal",
      signingPrivateKey: privateKey,
      httpClient: async () => ({ status: 404, json: async () => ({}) }),
    });
    const res = await client.fetchCallState("nope");
    expect(res).toMatchObject({ ok: false, status: 404, reason: "not_found" });
  });

  it("maps a 5xx to error (transient — retry next sweep)", async () => {
    const { privateKey } = makeKeypair();
    const client = new DialerReadClient({
      dialerBaseUrl: "https://dialer.internal",
      signingPrivateKey: privateKey,
      httpClient: async () => ({ status: 503, json: async () => ({}) }),
    });
    const res = await client.fetchCallState("x");
    expect(res).toMatchObject({ ok: false, status: 503, reason: "error" });
  });

  it("url-encodes the call id", async () => {
    const { privateKey } = makeKeypair();
    let url = "";
    const client = new DialerReadClient({
      dialerBaseUrl: "https://dialer.internal",
      signingPrivateKey: privateKey,
      httpClient: async (u) => {
        url = u;
        return { status: 200, json: async () => ({ status: "RINGING" }) };
      },
    });
    await client.fetchCallState("call/with space");
    expect(url).toBe("https://dialer.internal/dialer/v1/calls/call%2Fwith%20space");
  });
});
