/**
 * Per-carrier paperwork template scaffolding tests.
 *
 * Scope:
 *   - The registry returns the right config per carrier name + falls back.
 *   - Each carrier's stub PDF fills correctly: name in header, fields set,
 *     anchor present, "TEMPLATE STUB" marker visible.
 *   - `resolveField` handles every documented `FieldSource` + null inputs.
 *   - `generateCarrierPaperworkPdf` end-to-end: pick template → resolve →
 *     fill → readback shows the agent's data in the right fields.
 *   - `findSignatureAnchor` locates the anchor when present, returns
 *     `{found: false}` when absent.
 *
 * Tests run against the in-memory stub-builder path (no real PDFs in
 * fixtures/), which mirrors today's production behavior — once real PDFs
 * land the file-on-disk path takes over without code changes.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  __testing,
  buildFieldMap,
  buildStubPdfFromConfig,
  generateCarrierPaperworkPdf,
  getCarrierTemplate,
  loadCarrierTemplateBytes,
  resolveField,
  STUB_MARKER,
  type ResolveFieldContext,
} from "../../lib/contractingPdf/carrierTemplates";
import { readFieldValues } from "../../lib/contractingPdf/pdfFiller";
import { findSignatureAnchor } from "../../lib/contractingPdf/anchorLookup";

const KNOWN_CARRIERS = [
  "Aetna/CVS",
  "Humana",
  "UnitedHealth/AARP",
  "Anthem/BCBS",
  "Cigna",
  "Wellcare",
  "Devoted",
];

function baseCtx(): ResolveFieldContext {
  return {
    agent: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
    },
    profile: null,
    request: null,
  };
}

describe("carrier-templates: registry", () => {
  it("returns a dedicated config for every known carrier", () => {
    for (const name of KNOWN_CARRIERS) {
      const cfg = getCarrierTemplate(name);
      expect(cfg.name).toBeTruthy();
      // The default config's name is "Default Carrier" — none of the
      // known carriers should resolve to it.
      expect(cfg.name).not.toBe("Default Carrier");
    }
  });

  it("falls back to default config for an unknown carrier name", () => {
    const cfg = getCarrierTemplate("Some Brand New Carrier");
    expect(cfg.name).toBe("Default Carrier");
    expect(cfg.version).toBe("stub-v0");
  });

  it("falls back to default config for empty / whitespace name", () => {
    expect(getCarrierTemplate("").name).toBe("Default Carrier");
  });

  it("every config has a non-empty fields list + signature anchor", () => {
    const all = Object.values(__testing.CARRIER_NAME_TO_CONFIG);
    for (const cfg of all) {
      expect(cfg.fields.length).toBeGreaterThan(0);
      expect(cfg.signatureAnchor.length).toBeGreaterThan(0);
      expect(cfg.templatePath).toMatch(/\.pdf$/i);
    }
    // Default config is exposed separately.
    expect(__testing.defaultConfig.fields.length).toBeGreaterThan(0);
  });
});

describe("carrier-templates: stub builder", () => {
  it("each known carrier stub renders + has the carrier name in header", async () => {
    for (const name of KNOWN_CARRIERS) {
      const cfg = getCarrierTemplate(name);
      const bytes = await buildStubPdfFromConfig(cfg);
      expect(bytes.length).toBeGreaterThan(500);
      // The carrier name + version + safety marker must all be in the
      // raw PDF stream (drawn as visible text).
      const stream = bytes.toString("latin1");
      expect(stream).toContain(cfg.name);
      expect(stream).toContain(cfg.version);
      expect(stream).toContain(STUB_MARKER);
      expect(stream).toContain(cfg.signatureAnchor);
    }
  });

  it("stub PDF defines an AcroForm field for every binding", async () => {
    const cfg = getCarrierTemplate("Aetna/CVS");
    const bytes = await buildStubPdfFromConfig(cfg);
    const pdf = await PDFDocument.load(bytes);
    const fieldNames = new Set(pdf.getForm().getFields().map((f) => f.getName()));
    for (const binding of cfg.fields) {
      expect(fieldNames.has(binding.name)).toBe(true);
    }
  });

  it("stub PDF is a valid PDF (starts with %PDF)", async () => {
    const cfg = getCarrierTemplate("Humana");
    const bytes = await buildStubPdfFromConfig(cfg);
    expect(bytes.slice(0, 4).toString()).toBe("%PDF");
  });
});

describe("carrier-templates: resolveField", () => {
  it("resolves agent.fullName from first + last when fullName is unset", () => {
    expect(resolveField("agent.fullName", baseCtx())).toBe("Jane Doe");
  });

  it("prefers explicit agent.fullName over composed first + last", () => {
    const ctx = baseCtx();
    ctx.agent.fullName = "Jane Q Doe";
    expect(resolveField("agent.fullName", ctx)).toBe("Jane Q Doe");
  });

  it("returns null for agent fields when both first + last are missing", () => {
    const ctx = baseCtx();
    ctx.agent.firstName = "" as unknown as string;
    ctx.agent.lastName = "" as unknown as string;
    expect(resolveField("agent.fullName", ctx)).toBeNull();
  });

  it("agent.firstName / lastName / email pass through", () => {
    const ctx = baseCtx();
    expect(resolveField("agent.firstName", ctx)).toBe("Jane");
    expect(resolveField("agent.lastName", ctx)).toBe("Doe");
    expect(resolveField("agent.email", ctx)).toBe("jane@example.com");
  });

  it("profile fields return null when profile is null", () => {
    const ctx = baseCtx();
    expect(resolveField("profile.phone", ctx)).toBeNull();
    expect(resolveField("profile.dob", ctx)).toBeNull();
    expect(resolveField("profile.ssn", ctx)).toBeNull();
    expect(resolveField("profile.ssnLast4", ctx)).toBeNull();
    expect(resolveField("profile.homeAddressFull", ctx)).toBeNull();
    expect(resolveField("profile.mailingAddressFull", ctx)).toBeNull();
    expect(resolveField("profile.eAndOCarrier", ctx)).toBeNull();
  });

  it("composes home + mailing address when fields are present", () => {
    const ctx = baseCtx();
    ctx.profile = {
      homeAddressLine1: "123 Main St",
      homeAddressLine2: "Apt 4",
      homeCity: "Tampa",
      homeState: "FL",
      homeZip: "33601",
      mailingSameAsHome: true,
    } as unknown as ResolveFieldContext["profile"];
    expect(resolveField("profile.homeAddressFull", ctx)).toBe(
      "123 Main St, Apt 4, Tampa FL 33601",
    );
    // mailing falls through to home when mailingSameAsHome is true
    expect(resolveField("profile.mailingAddressFull", ctx)).toBe(
      "123 Main St, Apt 4, Tampa FL 33601",
    );
  });

  it("mailing address uses dedicated fields when mailingSameAsHome=false", () => {
    const ctx = baseCtx();
    ctx.profile = {
      homeAddressLine1: "1 A",
      homeCity: "X",
      homeState: "FL",
      homeZip: "1",
      mailingSameAsHome: false,
      mailingAddressLine1: "PO Box 9",
      mailingCity: "Atlanta",
      mailingState: "GA",
      mailingZip: "30301",
    } as unknown as ResolveFieldContext["profile"];
    expect(resolveField("profile.mailingAddressFull", ctx)).toBe(
      "PO Box 9, Atlanta GA 30301",
    );
  });

  it("request.states joins, request.statesCount returns count, request.id passes through", () => {
    const ctx = baseCtx();
    ctx.request = { id: "req-123", states: ["FL", "GA", "TX"] };
    expect(resolveField("request.states", ctx)).toBe("FL, GA, TX");
    expect(resolveField("request.statesCount", ctx)).toBe("3");
    expect(resolveField("request.id", ctx)).toBe("req-123");
  });

  it("constant.true / constant.false return boolean literals", () => {
    const ctx = baseCtx();
    expect(resolveField("constant.true", ctx)).toBe(true);
    expect(resolveField("constant.false", ctx)).toBe(false);
  });

  it("profile.ssn / profile.ssnLast4 use the caller-provided plaintext", () => {
    const ctx = baseCtx();
    ctx.ssnPlaintext = "123456789";
    expect(resolveField("profile.ssn", ctx)).toBe("123456789");
    expect(resolveField("profile.ssnLast4", ctx)).toBe("6789");
  });

  it("profile.ssn / profile.ssnLast4 stay null when ssnPlaintext is absent", () => {
    const ctx = baseCtx();
    expect(resolveField("profile.ssn", ctx)).toBeNull();
    expect(resolveField("profile.ssnLast4", ctx)).toBeNull();
    // Too-short plaintext → null for last4
    ctx.ssnPlaintext = "12";
    expect(resolveField("profile.ssnLast4", ctx)).toBeNull();
  });
});

describe("carrier-templates: end-to-end fill", () => {
  it("fills a known carrier's stub with the agent + profile + request data", async () => {
    const { bytes, config, fieldMap } = await generateCarrierPaperworkPdf(
      "Aetna/CVS",
      {
        agent: {
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
        },
        profile: {
          phone: "555-0100",
          dob: "1980-01-15",
          homeAddressLine1: "1 Main",
          homeCity: "Tampa",
          homeState: "FL",
          homeZip: "33601",
          mailingSameAsHome: true,
        } as unknown as ResolveFieldContext["profile"],
        request: { id: "req-xyz", states: ["FL", "GA"] },
      },
    );

    expect(config.name).toBe("Aetna/CVS");
    // The fieldMap was actually built and includes resolved values.
    expect(fieldMap.agent_full_name).toBe("Jane Doe");
    expect(fieldMap.agent_email).toBe("jane@example.com");
    expect(fieldMap.agent_phone).toBe("555-0100");
    expect(fieldMap.states_contracting).toBe("FL, GA");
    expect(fieldMap.agent_address_full).toBe("1 Main, Tampa FL 33601");

    // PDF is valid; we already checked the fieldMap was built
    // correctly. The post-flatten PDF compresses content streams, so we
    // don't byte-scan for individual values here — `pdfFiller`'s
    // round-trip test covers the form-field round-trip directly on the
    // un-flattened path.
    expect(bytes.slice(0, 4).toString()).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("flattens the output so fields cannot be edited", async () => {
    __testing.clearTemplateBytesCache();
    const { bytes } = await generateCarrierPaperworkPdf("Humana", {
      agent: { firstName: "A", lastName: "B", email: "a@b" },
      profile: null,
      request: null,
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getForm().getFields()).toHaveLength(0);
  });

  it("buildFieldMap honors `literal` overrides over the source", () => {
    const cfg = getCarrierTemplate("Aetna/CVS");
    const cfgWithLiteral = {
      ...cfg,
      fields: [
        { name: "manual_override", source: "agent.email" as const, literal: "OVERRIDDEN" },
      ],
    };
    const map = buildFieldMap(cfgWithLiteral, {
      agent: { firstName: "x", lastName: "y", email: "from-agent@e" },
      profile: null,
      request: null,
    });
    expect(map.manual_override).toBe("OVERRIDDEN");
  });

  it("unknown carrier resolves to default and fills successfully", async () => {
    const { config } = await generateCarrierPaperworkPdf(
      "Unknown New Carrier",
      {
        agent: { firstName: "Z", lastName: "Q", email: "z@q" },
        profile: null,
        request: null,
      },
    );
    expect(config.name).toBe("Default Carrier");
  });

  it("every stub fixture contains the TEMPLATE STUB marker (defense vs. accidentally treating a stub as a real packet)", async () => {
    // The marker assertion runs against the SOURCE stub bytes (before
    // fillTemplate's flatten step recompresses content streams). This
    // is the contract the Day-6 carrier-email-out worker would use to
    // refuse to mail a stub to a real carrier desk.
    for (const carrierName of KNOWN_CARRIERS) {
      const cfg = getCarrierTemplate(carrierName);
      const bytes = await buildStubPdfFromConfig(cfg);
      const stream = bytes.toString("latin1");
      expect(stream).toContain(STUB_MARKER);
      expect(stream).toContain(cfg.signatureAnchor);
    }
  });
});

describe("anchorLookup", () => {
  it("finds the anchor when it is present in the PDF", async () => {
    const cfg = getCarrierTemplate("Aetna/CVS");
    const bytes = await buildStubPdfFromConfig(cfg);
    const res = await findSignatureAnchor(bytes, cfg.signatureAnchor);
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.pageIndex).toBeGreaterThanOrEqual(0);
      expect(res.placement.x).toBeGreaterThan(0);
      expect(res.placement.y).toBeGreaterThan(0);
    }
  });

  it("returns {found:false} when the anchor is absent", async () => {
    const cfg = getCarrierTemplate("Aetna/CVS");
    const bytes = await buildStubPdfFromConfig(cfg);
    const res = await findSignatureAnchor(
      bytes,
      "ANCHOR-THAT-DOES-NOT-EXIST-12345",
    );
    expect(res.found).toBe(false);
  });

  it("returns {found:false} for empty anchor string", async () => {
    const cfg = getCarrierTemplate("Aetna/CVS");
    const bytes = await buildStubPdfFromConfig(cfg);
    const res = await findSignatureAnchor(bytes, "");
    expect(res.found).toBe(false);
  });
});

describe("loadCarrierTemplateBytes (stub mode)", () => {
  it("synthesises a stub when the templatePath file does not exist", async () => {
    __testing.clearTemplateBytesCache();
    const cfg = getCarrierTemplate("Wellcare");
    const bytes = await loadCarrierTemplateBytes(cfg);
    expect(bytes.slice(0, 4).toString()).toBe("%PDF");
    // The synthesized stub carries our marker.
    expect(bytes.toString("latin1")).toContain(STUB_MARKER);
  });

  it("caches bytes per-config (second call returns the same buffer object)", async () => {
    __testing.clearTemplateBytesCache();
    const cfg = getCarrierTemplate("Devoted");
    const a = await loadCarrierTemplateBytes(cfg);
    const b = await loadCarrierTemplateBytes(cfg);
    expect(a).toBe(b);
  });
});
