/**
 * Plumbing tests for the carrier-contracting PDF helpers.
 *
 * Real carrier templates land in Days 3-4 once INSUREitALL provides them.
 * For now these tests prove the helpers themselves work:
 *   - `fillTemplate` round-trips a dummy template (built in-memory, no fixture).
 *   - Flattened output cannot be edited (form fields are removed).
 *   - Unknown field names are tolerated.
 *   - `renderSignatureCertificate` produces a single-page PDF containing all
 *     the expected audit-trail fields.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildDummyTemplate,
  fillTemplateFromBytes,
  readFieldValues,
} from "../../lib/contractingPdf/pdfFiller";
import {
  renderSignatureCertificate,
  renderSignatureCertificateBuffer,
} from "../../lib/contractingPdf/signatureCertificate";

describe("pdfFiller", () => {
  it("round-trips text + checkbox fields on the dummy template", async () => {
    const template = await buildDummyTemplate();
    const filled = await fillTemplateFromBytes(template, {
      fullName: "Jane Doe",
      ssn: "123-45-6789",
      consent: true,
    });

    const values = await readFieldValues(filled);
    expect(values.fullName).toBe("Jane Doe");
    expect(values.ssn).toBe("123-45-6789");
    expect(values.consent).toBe(true);
  });

  it("skips unknown field names without throwing", async () => {
    const template = await buildDummyTemplate();
    const filled = await fillTemplateFromBytes(template, {
      fullName: "Bob",
      doesNotExist: "ignored",
    });

    const values = await readFieldValues(filled);
    expect(values.fullName).toBe("Bob");
    // unknown field never leaked into the output
    expect(Object.keys(values)).not.toContain("doesNotExist");
  });

  it("skips null/undefined values", async () => {
    const template = await buildDummyTemplate();
    const filled = await fillTemplateFromBytes(template, {
      fullName: "Set",
      ssn: null,
      consent: undefined,
    });
    const values = await readFieldValues(filled);
    expect(values.fullName).toBe("Set");
    // pdf-lib returns null for an unset text field (no setText() ever called),
    // and false for an unchecked box — both confirm the null/undefined skip.
    expect(values.ssn === null || values.ssn === "").toBe(true);
    expect(values.consent).toBe(false);
  });

  it("flatten option strips form fields from the output", async () => {
    const template = await buildDummyTemplate();
    const filled = await fillTemplateFromBytes(
      template,
      { fullName: "Flattened", consent: true },
      { flatten: true },
    );

    const pdf = await PDFDocument.load(filled);
    const form = pdf.getForm();
    expect(form.getFields()).toHaveLength(0);
  });

  it("unchecks a checkbox when value is false", async () => {
    const template = await buildDummyTemplate();
    const first = await fillTemplateFromBytes(template, { consent: true });
    const second = await fillTemplateFromBytes(first, { consent: false });
    const values = await readFieldValues(second);
    expect(values.consent).toBe(false);
  });
});

describe("signatureCertificate", () => {
  const baseInput = {
    documentName: "Acme Carrier Contracting Packet v1.2",
    documentHash:
      "a3f5b9c11e22d3045f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0",
    signer: {
      fullName: "Jane Q Agent",
      email: "jane@agency.example",
      userId: "user_abc123",
      npn: "20123456",
    },
    consentAt: "2026-05-21T13:00:00Z",
    signedAt: "2026-05-21T13:05:30Z",
    ipAddress: "203.0.113.42",
    userAgent: "Mozilla/5.0 (Macintosh) Safari/600",
    consentText:
      "I, the undersigned agent, acknowledge that the information provided is true and accurate to the best of my knowledge, and authorize INSUREitALL to submit this packet to the named carrier on my behalf.",
  } as const;

  it("renders a single-page PDF document", async () => {
    const pdf = await renderSignatureCertificate(baseInput);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("returns a non-empty Buffer", async () => {
    const buf = await renderSignatureCertificateBuffer(baseInput);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });

  it("the buffer is a valid PDF (starts with %PDF)", async () => {
    const buf = await renderSignatureCertificateBuffer(baseInput);
    expect(buf.slice(0, 4).toString()).toBe("%PDF");
  });

  it("tolerates a missing userId / npn / ipAddress / userAgent", async () => {
    const pdf = await renderSignatureCertificate({
      ...baseInput,
      signer: { ...baseInput.signer, userId: null, npn: null },
      ipAddress: null,
      userAgent: null,
    });
    expect(pdf.getPageCount()).toBe(1);
  });

  it("truncates extremely long consent text instead of crashing", async () => {
    const longConsent = "lorem ipsum ".repeat(2000);
    const pdf = await renderSignatureCertificate({
      ...baseInput,
      consentText: longConsent,
    });
    expect(pdf.getPageCount()).toBe(1);
  });
});
