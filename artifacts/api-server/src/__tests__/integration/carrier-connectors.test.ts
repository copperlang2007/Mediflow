/**
 * Tests for the carrier-connector abstraction.
 *
 *  - emailConnector returns a synthetic providerRequestId and logs the
 *    destination (Day-6 swap-in target for the real Resend call).
 *  - emailConnector tolerates a missing appointment-desk email — the v1
 *    stub flow must keep advancing even before INSUREitALL provides all
 *    desk addresses, but it logs loudly so the gap stays visible.
 *  - Registry returns emailConnector for unregistered carriers (default).
 *  - registerCarrierConnector swaps the binding for a specific carrierId
 *    without affecting others.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger } from "../../lib/logger";
import { emailConnector } from "../../lib/carrierConnectors/emailConnector";
import {
  registerCarrierConnector,
  unregisterCarrierConnector,
  resolveCarrierConnector,
  listRegisteredCarrierConnectors,
} from "../../lib/carrierConnectors";
import type {
  CarrierConnector,
  ContractingPacket,
} from "../../lib/carrierConnectors/types";

function makePacket(overrides: Partial<ContractingPacket> = {}): ContractingPacket {
  return {
    carrierId: "carrier-acme",
    carrierName: "Acme Health",
    contractingRequestId: "req-1",
    agentId: "agent-1",
    states: ["FL", "GA"],
    profile: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "555-1212",
      ssn: "123456789",
      dob: "1980-01-01",
      npn: "20123456",
      homeAddress: {
        line1: "1 Test Ln",
        line2: null,
        city: "Tampa",
        state: "FL",
        zip: "33602",
      },
      mailingAddress: null,
      entityType: "individual",
      businessName: null,
      ein: null,
      eAndO: { carrier: null, policyNumber: null, expiresOn: null },
    },
    signedPdf: Buffer.from("%PDF-1.7 stub", "utf8"),
    appointmentDeskEmail: "appointments@acme.example",
    appointmentDeskMetadata: { source: "test" },
    ...overrides,
  };
}

describe("emailConnector", () => {
  let logInfoSpy: ReturnType<typeof vi.spyOn>;
  let logWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logInfoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    logWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    logInfoSpy.mockRestore();
    logWarnSpy.mockRestore();
  });

  it("returns a non-empty synthetic providerRequestId", async () => {
    const { providerRequestId } = await emailConnector.submit(makePacket());
    expect(providerRequestId).toMatch(/^email-stub-/);
    expect(providerRequestId.length).toBeGreaterThan("email-stub-".length);
  });

  it("logs the destination email at info level", async () => {
    await emailConnector.submit(makePacket());
    expect(logInfoSpy).toHaveBeenCalled();
    const call = logInfoSpy.mock.calls[0];
    const msg = call?.[1] ?? "";
    expect(String(msg)).toContain("appointments@acme.example");
  });

  it("warns (does not throw) when appointment-desk email is missing", async () => {
    const { providerRequestId } = await emailConnector.submit(
      makePacket({ appointmentDeskEmail: null }),
    );
    expect(providerRequestId).toMatch(/^email-stub-/);
    expect(logWarnSpy).toHaveBeenCalled();
  });

  it("pollStatus returns 'unknown' — email is fire-and-forget", async () => {
    const res = await emailConnector.pollStatus({
      id: "req-1",
      carrierId: "carrier-acme",
      signatureEnvelopeId: null,
    });
    expect(res.status).toBe("unknown");
  });

  it("two submits return different providerRequestIds", async () => {
    const a = await emailConnector.submit(makePacket());
    const b = await emailConnector.submit(makePacket());
    expect(a.providerRequestId).not.toBe(b.providerRequestId);
  });
});

describe("carrierConnector registry", () => {
  afterEach(() => {
    // Clean up any registrations a test made so suites don't leak state.
    for (const { carrierId } of listRegisteredCarrierConnectors()) {
      unregisterCarrierConnector(carrierId);
    }
  });

  it("defaults to emailConnector for unregistered carriers", () => {
    const c = resolveCarrierConnector("never-registered-carrier");
    expect(c.name).toBe(emailConnector.name);
  });

  it("registerCarrierConnector binds a specific carrierId", () => {
    const fake: CarrierConnector = {
      name: "Acme Native",
      submit: async () => ({ providerRequestId: "native-1" }),
      pollStatus: async () => ({ status: "acknowledged" }),
    };
    registerCarrierConnector("carrier-acme", fake);
    expect(resolveCarrierConnector("carrier-acme").name).toBe("Acme Native");
    expect(resolveCarrierConnector("carrier-other").name).toBe(
      emailConnector.name,
    );
  });

  it("listRegisteredCarrierConnectors returns only native bindings", () => {
    const fake: CarrierConnector = {
      name: "Aetna",
      submit: async () => ({ providerRequestId: "aet-1" }),
      pollStatus: async () => ({ status: "under_review" }),
    };
    registerCarrierConnector("carrier-aetna", fake);
    const list = listRegisteredCarrierConnectors();
    expect(list).toEqual([{ carrierId: "carrier-aetna", name: "Aetna" }]);
  });
});
