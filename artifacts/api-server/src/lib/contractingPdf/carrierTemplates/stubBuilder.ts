/**
 * Stub-PDF synthesis from a `CarrierTemplateConfig`.
 *
 * Why build stubs at call time instead of committing binary fixtures?
 *   - Binary fixtures bloat git diffs (a 50KB PDF is a noisy blob when
 *     all that changed is the header text).
 *   - Stubs and config drift apart silently when they're separate artifacts;
 *     building from the same config eliminates that drift.
 *   - INSUREitALL will swap REAL PDFs into `fixtures/` later — at that
 *     point `templatePath` resolves to a committed file and this builder
 *     is bypassed automatically. So the stub path is throwaway scaffolding.
 *
 * Every stub is loudly stamped "TEMPLATE STUB — NOT THE REAL CARRIER PACKET"
 * so a reviewer who downloads a draft from the admin UI immediately sees
 * the safety marker. The Day-6 carrier-desk email-out worker can scan
 * for this marker as a defense against accidentally emailing a stub.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { CarrierTemplateConfig } from "./types";

/** The exact marker string every stub PDF must contain. */
export const STUB_MARKER = "TEMPLATE STUB - NOT THE REAL CARRIER PACKET";

/**
 * Build a one-page PDF whose AcroForm fields match the binding list in
 * `config.fields`. Every field gets a labelled text box (or checkbox for
 * `constant.true` / `constant.false` literals).
 *
 * The `config.signatureAnchor` string is drawn at the bottom of the page
 * so the e-sign provider's anchor lookup can find it.
 */
export async function buildStubPdfFromConfig(
  config: CarrierTemplateConfig,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();

  // Stamp the carrier name, version, marker, AND the signature anchor
  // into the document's metadata. pdf-lib writes the Info dict
  // uncompressed in the trailer, so these strings are reliably findable
  // via a raw `Buffer.indexOf` (used by both the test assertions and
  // the production-side `findSignatureAnchor`). Drawing them on the
  // page as visible text alone is not enough — page content streams
  // are FlateDecode-compressed.
  pdf.setTitle(`${config.name} ${config.version} ${STUB_MARKER}`);
  pdf.setSubject(`Signature anchor: ${config.signatureAnchor}`);
  pdf.setKeywords([config.name, config.version, STUB_MARKER, config.signatureAnchor]);
  pdf.setProducer(`mediflow-carrier-template-stub (${config.version})`);
  // US Letter — same as the certificate page so reviewers can scroll through
  // a combined doc without page-size jumps.
  const page = pdf.addPage([612, 792]);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // Header — carrier name + version, prominent so a printed copy is obviously
  // a stub when an admin glances at it.
  let y = 760;
  page.drawText(`${config.name} - Contracting Stub`, {
    x: 50,
    y,
    size: 16,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  y -= 18;
  page.drawText(`version: ${config.version}`, {
    x: 50,
    y,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Safety marker — RED so it can't be missed in print or screen review.
  y -= 22;
  page.drawText(STUB_MARKER, {
    x: 50,
    y,
    size: 11,
    font: fontBold,
    color: rgb(0.8, 0, 0),
  });
  y -= 14;
  page.drawText(
    "Real INSUREitALL carrier paperwork will replace this file via templatePath.",
    { x: 50, y, size: 8, font, color: rgb(0.3, 0.3, 0.3) },
  );

  // Form fields. Layout: label + 24pt-tall field, two columns where space
  // allows. We don't try to perfectly mimic any real carrier layout — the
  // goal is "every binding from `config.fields` is fillable" so the
  // `fillTemplate` round-trip works.
  const form = pdf.getForm();
  y -= 26;

  const fieldHeight = 18;
  const labelOffset = 12;
  const rowSpacing = 36;
  const fieldWidth = 510;

  for (const binding of config.fields) {
    if (y < 80) {
      // Out of space — add another page so every binding is present.
      y = 760;
      pdf.addPage([612, 792]);
    }
    const currentPage = pdf.getPages()[pdf.getPageCount() - 1];
    if (!currentPage) continue;

    currentPage.drawText(`${binding.name}  (<- ${binding.source})`, {
      x: 50,
      y,
      size: 8,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });

    // Use a checkbox for boolean literals; text field for everything else.
    if (
      binding.literal === true ||
      binding.literal === false ||
      binding.source === "constant.true" ||
      binding.source === "constant.false"
    ) {
      const cb = form.createCheckBox(binding.name);
      cb.addToPage(currentPage, {
        x: 50,
        y: y - labelOffset - 6,
        width: 14,
        height: 14,
      });
    } else {
      const tf = form.createTextField(binding.name);
      tf.setText("");
      tf.addToPage(currentPage, {
        x: 50,
        y: y - labelOffset - fieldHeight,
        width: fieldWidth,
        height: fieldHeight,
      });
    }
    y -= rowSpacing;
  }

  // Signature anchor — bottom of the LAST page (where the e-sign provider's
  // anchor lookup will hunt for it). We draw it as visible text so the
  // anchor string is searchable in the PDF text stream.
  const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
  if (lastPage) {
    lastPage.drawText(`Signature anchor: ${config.signatureAnchor}`, {
      x: 50,
      y: 60,
      size: 9,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
    lastPage.drawText(config.signatureAnchor, {
      x: 50,
      y: 44,
      size: 11,
      font: fontBold,
      color: rgb(0, 0, 0),
    });
  }

  // `useObjectStreams: false` keeps cross-reference + Info dicts in
  // their classic non-stream form. Page content streams are still
  // FlateDecode-compressed (pdf-lib has no top-level toggle for that),
  // which means a naive byte scan of the result won't find the marker
  // strings drawn on the page. To make the marker + anchor reliably
  // discoverable to `Buffer.indexOf` (used by `findSignatureAnchor`
  // and by the test suite that confirms every stub carries the
  // marker), we append a PDF comment trailer with the well-known
  // strings. PDF parsers ignore content after `%%EOF`; the trailing
  // bytes are pure observability scaffolding.
  const baseBytes = await pdf.save({ useObjectStreams: false });
  const trailer = Buffer.from(
    `\n% mediflow-carrier-template-stub\n% marker: ${STUB_MARKER}\n% anchor: ${config.signatureAnchor}\n% carrier: ${config.name}\n% version: ${config.version}\n`,
    "utf8",
  );
  return Buffer.concat([Buffer.from(baseBytes), trailer]);
}
