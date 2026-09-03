/**
 * Tests for the carrier-connector abstraction.
 *
 *  - emailConnector transmits through Resend and returns the real provider
 *    message id.
 *  - emailConnector REFUSES to report success it did not earn: a missing
 *    appointment-desk address or unconfigured email throws, so the carrier
 *    request cannot advance to "submitted" while nothing was sent.
 *  - The dry-run escape hatch is explicit and its ids are unmistakable.
 *  - Registry returns emailConnector for unregistered carriers (default).
 *  - registerCarrierConnector swaps the binding for a specific carrierId
 *    without affecting others.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The connector calls Resend through `lib/email`. Stub it so these tests
// exercise the connector's contract, not the network.
vi.mock("../../lib/email", () => ({
  isEmailConfigured: (): boolean => process.env.RESEND_API_KEY != null,
  sendEmail: vi.fn(async () => ({ success: true, id: "resend-msg-abc123" })),
}));

import { logger } from "../../lib/logger";
import { sendEmail } from "../../lib/email";
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

  const savedEnv = {
    resend: process.env.RESEND_API_KEY,
    dryRun: process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN,
  };

  beforeEach(() => {
    logInfoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    logWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.mocked(sendEmail).mockClear();
    delete process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN;
    process.env.RESEND_API_KEY = "re_test_key";
  });

  afterEach(() => {
    logInfoSpy.mockRestore();
    logWarnSpy.mockRestore();
    // Restore the ambient env so connector tests cannot leak transport config
    // into whatever runs next in this worker.
    if (savedEnv.resend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedEnv.resend;
    if (savedEnv.dryRun === undefined)
      delete process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN;
    else process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN = savedEnv.dryRun;
  });

  it("transmits through Resend and returns the provider message id", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    const { providerRequestId } = await emailConnector.submit(makePacket());

    // The id must be traceable to a real delivery — a synthetic id here is
    // what previously let an untransmitted request look submitted.
    expect(providerRequestId).toBe("resend-msg-abc123");
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const opts = vi.mocked(sendEmail).mock.calls[0]?.[0];
    expect(opts?.to).toEqual({ email: "appointments@acme.example" });
    expect(opts?.attachments?.[0]?.filename).toContain("req-1");
  });

  it("throws when no appointment-desk email is configured", async () => {
    // Advancing here is exactly the unsafe behavior this connector used to
    // have: a request marked submitted with no destination on record.
    await expect(
      emailConnector.submit(makePacket({ appointmentDeskEmail: null })),
    ).rejects.toThrow(/No appointment-desk email is configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws when email transport is not configured", async () => {
    delete process.env.RESEND_API_KEY;

    await expect(emailConnector.submit(makePacket())).rejects.toThrow(
      /RESEND_API_KEY is not set/,
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("surfaces a provider send failure rather than swallowing it", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.mocked(sendEmail).mockResolvedValueOnce({
      success: false,
      error: "domain not verified",
    });

    await expect(emailConnector.submit(makePacket())).rejects.toThrow(
      /Email send to appointment desk failed.*domain not verified/,
    );
  });

  it("dry run sends nothing and returns an unmistakable id", async () => {
    process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN = "true";

    const { providerRequestId } = await emailConnector.submit(makePacket());

    expect(providerRequestId).toMatch(/^dry-run-/);
    expect(sendEmail).not.toHaveBeenCalled();
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

  it("gives every dry run a distinct id", async () => {
    process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN = "true";
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
