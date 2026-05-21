/**
 * Generic PDF form-fill plumbing for carrier-contracting paperwork.
 *
 * Backed by `pdf-lib` (added to `artifacts/api-server/package.json`). The
 * function shape is intentionally narrow: load a template, set named form
 * fields, return a Buffer. No carrier-specific logic lives here.
 *
 * Why a separate module instead of inline `pdf-lib` calls per carrier?
 *  - Field-name → value mapping is the part that varies per carrier; the
 *    "load + set + save + bytes-out" plumbing is identical for everyone.
 *  - Test fixtures (`__tests__/pdf-filler.test.ts`) round-trip a tiny
 *    dummy template — proving the plumbing works BEFORE any real templates
 *    arrive from INSUREitALL.
 *
 * Real per-carrier templates land in Days 3-4 once INSUREitALL provides
 * the source PDFs and their AcroForm field names.
 */
import { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts } from "pdf-lib";
import * as fs from "node:fs/promises";

/**
 * Field-map shape. Values:
 *   - `string`: written to a text field via `setText(value)`.
 *   - `boolean`: written to a checkbox via `check()` / `uncheck()`.
 *   - `null` / `undefined`: skipped (no-op).
 *
 * Unknown field names log a warning and are skipped — a template-version
 * drift shouldn't crash paperwork generation, but it should be observable.
 */
export type PdfFieldValue = string | boolean | null | undefined;
export type PdfFieldMap = Record<string, PdfFieldValue>;

export interface FillTemplateOptions {
  /**
   * If true, the form is flattened after filling — fields become baked-in
   * text/checkbox graphics and can no longer be edited. Most carrier desks
   * expect a flattened PDF for archival.
   */
  flatten?: boolean;
}

/**
 * Load `templatePath`, set every field in `fieldMap`, and return the
 * resulting PDF as a Node Buffer.
 */
export async function fillTemplate(
  templatePath: string,
  fieldMap: PdfFieldMap,
  options: FillTemplateOptions = {},
): Promise<Buffer> {
  const templateBytes = await fs.readFile(templatePath);
  return fillTemplateFromBytes(templateBytes, fieldMap, options);
}

/**
 * Same as `fillTemplate` but accepts the template bytes directly — used by
 * tests that ship a fixture as a base64-encoded constant, and by future
 * call-sites that load the template from object storage.
 */
export async function fillTemplateFromBytes(
  templateBytes: Buffer | Uint8Array,
  fieldMap: PdfFieldMap,
  options: FillTemplateOptions = {},
): Promise<Buffer> {
  const pdf = await PDFDocument.load(templateBytes);
  const form = pdf.getForm();

  const fieldNames = new Set(form.getFields().map((f) => f.getName()));

  for (const [name, value] of Object.entries(fieldMap)) {
    if (value === null || value === undefined) continue;

    if (!fieldNames.has(name)) {
      // Drift between the template and our field map — warn but don't bail.
      // The route surfaces the list of unknown fields to ops.
      // eslint-disable-next-line no-console
      console.warn(`pdfFiller: template has no field named '${name}', skipping`);
      continue;
    }

    const field = form.getField(name);
    if (field instanceof PDFTextField) {
      field.setText(String(value));
    } else if (field instanceof PDFCheckBox) {
      if (value === true || value === "true") field.check();
      else field.uncheck();
    } else {
      // Radio groups / dropdowns are uncommon on carrier forms — log + skip
      // until we have a real example to drive the implementation.
      // eslint-disable-next-line no-console
      console.warn(
        `pdfFiller: field '${name}' is of unsupported type ${field.constructor.name}`,
      );
    }
  }

  if (options.flatten) {
    form.flatten();
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/**
 * Convenience for tests + Day-3+ template scaffolding. Builds a tiny one-page
 * PDF with two text fields and one checkbox. Returns the byte buffer.
 * Useful as a stand-in template when a real carrier PDF is not yet available.
 */
export async function buildDummyTemplate(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Dummy Contracting Form", { x: 50, y: 260, size: 16, font });

  const form = pdf.getForm();

  const fullName = form.createTextField("fullName");
  fullName.setText("");
  fullName.addToPage(page, { x: 50, y: 200, width: 300, height: 24 });

  const ssn = form.createTextField("ssn");
  ssn.setText("");
  ssn.addToPage(page, { x: 50, y: 150, width: 300, height: 24 });

  const consent = form.createCheckBox("consent");
  consent.addToPage(page, { x: 50, y: 100, width: 20, height: 20 });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/** For tests — read back every field's current value as a map. */
export async function readFieldValues(
  pdfBytes: Buffer | Uint8Array,
): Promise<Record<string, string | boolean | null>> {
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const out: Record<string, string | boolean | null> = {};
  for (const field of form.getFields()) {
    const name = field.getName();
    if (field instanceof PDFTextField) {
      out[name] = field.getText() ?? null;
    } else if (field instanceof PDFCheckBox) {
      out[name] = field.isChecked();
    } else {
      out[name] = null;
    }
  }
  return out;
}
